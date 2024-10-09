import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { chromium } from "playwright";
import { stringify } from "csv-stringify";

const app = new Hono();

app.use("/*", serveStatic({ root: "./public" }));

app.get("/progress", (c) => {
  return streamSSE(c, async (stream) => {
    while (true) {
      if (global.progress) {
        await stream.writeSSE({ data: JSON.stringify(global.progress) });
        if (
          global.progress.status === "completed" ||
          global.progress.status === "error"
        ) {
          break;
        }
      }
      await stream.sleep(1000);
    }
  });
});

app.post("/scrap", async (c) => {
  const { nameSheet, googleUrl } = await c.req.json();

  if (!nameSheet || !googleUrl) {
    return c.json({ error: "nameSheet and googleUrl are required" }, 400);
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
      return c.json({ error: "Scrollable element not found" }, 500);
    }

    let endOfList = false;
    let index = 0;
    while (!endOfList) {
      await scrollable.evaluate((node) => node.scrollBy(0, 50000));
      endOfList = await page.evaluate(() =>
        document.body.innerText.includes("You've reached the end of the list")
      );
      console.log("scroll " + index);
      global.progress = { status: "scrolling", progress: index };

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
      await newPage.goto(url, { timeout: 0 });
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
      global.progress = {
        status: "scraping",
        progress: Math.round(((i + batchSize) / urls.length) * 100),
      };
    }

    await browser.close();
    console.timeEnd("Execution Time");

    const csvString = await new Promise((resolve, reject) => {
      stringify(results, { header: true }, (err, output) => {
        if (err) reject(err);
        else resolve(output);
      });
    });

    c.header("Content-Type", "text/csv");
    c.header("Content-Disposition", `attachment; filename=${nameSheet}`);

    global.progress = { status: "completed", progress: 100 };

    return c.body(csvString);
  } catch (error) {
    console.error("Error during scraping:", error);
    global.progress = { status: "error", message: error.message };
    return c.json({ error: "An error occurred during scraping" }, 500);
  }
});

export default {
  port: 3000,
  fetch: app.fetch,
};
