# WebDecoy Crawler Sensor

Reports automated traffic on your Netlify site to WebDecoy, with no change to your source. An edge function is injected at build time and runs before your site's own edge functions and framework middleware; it never changes a response, and a reporting failure never affects your visitors.

## What it sees

Every request to your site, at Netlify's edge, including crawlers that never run JavaScript. It reports the requests that look automated: known crawlers and tools by user agent, requests with no user agent, crawler-only paths such as `/robots.txt`, and browsers missing the headers real browsers send.

## What it never does

It does not block, redirect, challenge or slow any request. It does not read request bodies or cookies. It is monitoring only.

## Setup

1. Install this extension on your team.
2. In WebDecoy, open the site's Setup page and choose Netlify. Copy the three values it shows.
3. On the Netlify site, add environment variables `WEBDECOY_SITE_KEY`, `WEBDECOY_SCANNER_ID` and `WEBDECOY_SENSOR_KEY` (the last one is a secret), with the **Functions** scope.
4. Trigger a deploy. The sensor is injected into that build.

To stop: remove the variables and deploy again. The next build injects nothing.
