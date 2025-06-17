import fs from "node:fs/promises";
import "dotenv/config";
import { parse } from "csv-parse/sync";
import Pelias from "pelias-js";
import pMap from 'p-map';
import pThrottle from "p-throttle";

// We need a data file, look for a file path to be passed in
// We can use `minimist` if this needs to be more complex, but
// for now just reading args is fine.
// Throw an error if it doesn't exist
const args = process.argv.slice(2)
if (args.length === 0) {
  console.log('Please provide a file path to parse.')
  process.exit(1);
}

const filePath = args[0];

// This is the column from the CSV we are reading
const COLUMN_NAME = "Rack Address";

// Initialize geocoder client
const pelias = new Pelias.default({
  peliasUrl: `https://${process.env.PELIAS_HOST_NAME}`,
  apiKey: process.env.PELIAS_API_KEY,
});

// Set our focus point around Philadelphia City Hall to make it easier
// to hit the right address when it's missing city or zip code
pelias.search.setFocusPoint({ lat: "39.952", lon: "-75.164" });

// Read data
const content = await fs.readFile(filePath,
  "utf-8"
);

// Parse CSV as objects
const records = parse(content, {
  columns: true,
  skip_empty_lines: true,
});

// Create search function
function doSearch (record) {
  const address = record[COLUMN_NAME];
  return new Promise((resolve, reject) => {
    // Skip if no address in record
    if (address === "") {
      resolve(null)
    }

    pelias.search
      .setSearchTerm(address)
      .execute()
      .then((response) => {
        resolve({
          record,
          response,
        });
      })
      .catch((error) => {
        console.log(`Error geocoding '${address}': ${error}`);
        reject({
          record,
          error,
        });
      });
  })
}

// Not sure what the rate limit is but this is conservative.
// We can probably bump this up until we hit 429s
const throttle = pThrottle({
  limit: 10,
  interval: 1000
});

const throttled = throttle(doSearch);

// I don't exactly know how many of these we can run at a time
// This is where we geocode each address
const results = await pMap(records, throttled, {
  concurrency: 5
});

// Output a GeoJSON with the result of the first search result of each
// geocoding query. Filter out results that are null (no address in source
// record)
const features = results.filter(r => r !== null).map((result) => {
  const { record, response } = result;
  const feature = response.features[0];

  return {
    type: 'Feature',
    // It's possible to get back an empty feature? So we put null here
    geometry: feature?.geometry ?? null,
    properties: {
      ...record
    }
  }
})

const geojson = {
  type: 'FeatureCollection',
  features
}

console.log(JSON.stringify(geojson))
