# WebDecoy Crawler Sensor

Reports the automated traffic on your Netlify site to WebDecoy, with no change to your source. The extension injects one edge function into your site's next build. It runs at Netlify's edge on every request, reports the ones that look automated, and leaves every response untouched. It sees crawlers that never run JavaScript, which a script tag cannot.

## What it reports

Requests whose user agent names a known crawler or tool, requests with no user agent, requests for crawler-only paths such as `/robots.txt`, and browsers missing headers real browsers send. Static assets are skipped. Human visitors with ordinary browsers are never reported.

## What it never does

**Monitoring only.** It never blocks, redirects, challenges or slows a request, and a reporting failure never affects your visitors. It does not read request bodies or cookie values. Installing the extension changes nothing on any site: a site gets the sensor only after you set the variables below on that site.

## Setup

1. Install this extension on your Netlify team.
2. In WebDecoy, open the site's **Setup** page and choose **Netlify**. It shows three values.
3. On the Netlify site, under **Site configuration → Environment variables**, add them with the **Functions** scope:

   | Variable | What it is |
   |---|---|
   | `WEBDECOY_SITE_KEY` | The organization the sensor reports under |
   | `WEBDECOY_SCANNER_ID` | This site's detection script id |
   | `WEBDECOY_SENSOR_KEY` | A secret that proves the sensor is one WebDecoy issued. Keep it in Netlify's environment, never in a file you commit |

4. Trigger a deploy. The sensor is injected into that build.

To prove it end to end, request any page with the user agent `WebDecoy-Test/1.0`. WebDecoy labels that request a test, not a finding.

## What it costs

Every non-asset request invokes the edge function, which counts as an edge function invocation on your Netlify plan. The function does no network work before your response is sent.

## Remove

Delete the three variables and deploy again. The next build injects nothing.

Full documentation: [docs.webdecoy.com/installation/netlify](https://docs.webdecoy.com/installation/netlify/)
