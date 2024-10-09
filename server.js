const express = require("express");
const { chromium } = require("playwright");
const { Transform } = require("stream");
const { stringify } = require("csv-stringify");
const path = require("path");

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/progress", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  req.on("close", () => {
    console.log("Client closed connection");
  });

  global.sendProgress = (progress) => {
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  };
});

app.post("/scrap", async (req, res) => {
  const { nameSheet, googleUrl } = req.body;

  if (!nameSheet || !googleUrl) {
    return res
      .status(400)
      .json({ error: "nameSheet and googleUrl are required" });
  }

  try {
    console.time("Execution Time");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(googleUrl);
    await page.waitForSelector('[jstcache="3"]');

    const scrollable = await page.$(
      "xpath=/html/body/div[2]/div[3]/div[8]/div[9]/div/div/div[1]/div[2]/div/div[1]/div/div/div[1]/div[1]"
    );
    if (!scrollable) {
      console.log("Scrollable element not found.");
      await browser.close();
      return res.status(500).json({ error: "Scrollable element not found" });
    }

    let endOfList = false;
    let index = 0;
    while (!endOfList) {
      await scrollable.evaluate((node) => node.scrollBy(0, 50000));
      endOfList = await page.evaluate(() =>
        document.body.innerText.includes("You've reached the end of the list")
      );
      console.log("scroll " + index);
      global.sendProgress({ status: "scrolling", progress: index });

      if (index === 200) {
        endOfList = true;
      }

      index++;
    }

    const urls = await page.$$eval("a", (links) =>
      links
        .map((link) => link.href)
        .filter((href) => href.startsWith("https://www.google.com/maps/place/"))
    );

    const scrapePageData = async (url) => {
      const newPage = await browser.newPage();
      await newPage.goto(url);
      await newPage.waitForSelector('[jstcache="3"]');

      // Scrape required details
      const nameElement = await newPage.$(
        "xpath=/html/body/div[2]/div[3]/div[8]/div[9]/div/div/div[1]/div[2]/div/div[1]/div/div/div[2]/div/div[1]/div[1]/h1"
      );
      let name = nameElement
        ? await newPage.evaluate((element) => element.textContent, nameElement)
        : "";

      const ratingElement = await newPage.$(
        "xpath=/html/body/div[2]/div[3]/div[8]/div[9]/div/div/div[1]/div[2]/div/div[1]/div/div/div[2]/div/div[1]/div[2]/div/div[1]/div[2]/span[1]/span[1]"
      );
      let rating = ratingElement
        ? await newPage.evaluate(
            (element) => element.textContent,
            ratingElement
          )
        : "";

      const reviewsElement = await newPage.$(
        "xpath=/html/body/div[2]/div[3]/div[8]/div[9]/div/div/div[1]/div[2]/div/div[1]/div/div/div[2]/div/div[1]/div[2]/div/div[1]/div[2]/span[2]/span/span"
      );
      let reviews = reviewsElement
        ? await newPage.evaluate(
            (element) => element.textContent,
            reviewsElement
          )
        : "";
      reviews = reviews.replace(/\(|\)/g, "");

      const categoryElement = await newPage.$(
        "xpath=/html/body/div[2]/div[3]/div[8]/div[9]/div/div/div[1]/div[2]/div/div[1]/div/div/div[2]/div/div[1]/div[2]/div/div[2]/span/span/button"
      );
      let category = categoryElement
        ? await newPage.evaluate(
            (element) => element.textContent,
            categoryElement
          )
        : "";

      const addressElement = await newPage.$(
        'button[data-tooltip="Copy address"]'
      );
      let address = addressElement
        ? await newPage.evaluate(
            (element) => element.textContent,
            addressElement
          )
        : "";

      const websiteElement =
        (await newPage.$('a[data-tooltip="Open website"]')) ||
        (await newPage.$('a[data-tooltip="Open menu link"]'));
      let website = websiteElement
        ? await newPage.evaluate(
            (element) => element.getAttribute("href"),
            websiteElement
          )
        : "";

      const phoneElement = await newPage.$(
        'button[data-tooltip="Copy phone number"]'
      );
      let phone = phoneElement
        ? await newPage.evaluate((element) => element.textContent, phoneElement)
        : "";

      await newPage.close();
      return { name, rating, reviews, category, address, website, phone, url };
    };

    const batchSize = 5;
    const results = [];

    for (let i = 0; i < urls.length; i += batchSize) {
      const batchUrls = urls.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batchUrls.map((url) => scrapePageData(url))
      );
      results.push(...batchResults);
      console.log(`Batch ${i / batchSize + 1} completed.`);
      global.sendProgress({
        status: "scraping",
        progress: Math.round(((i + batchSize) / urls.length) * 100),
      });
    }

    await browser.close();
    console.timeEnd("Execution Time");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=${nameSheet}`);

    const stringifier = stringify({
      header: true,
      columns: Object.keys(results[0]),
    });

    const resultStream = new Transform({
      objectMode: true,
      transform(chunk, encoding, callback) {
        this.push(chunk);
        callback();
      },
    });

    results.forEach((result) => resultStream.push(result));
    resultStream.push(null);

    resultStream.pipe(stringifier).pipe(res);

    global.sendProgress({ status: "completed", progress: 100 });
  } catch (error) {
    console.error("Error during scraping:", error);
    res.status(500).json({ error: "An error occurred during scraping" });
    global.sendProgress({ status: "error", message: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
