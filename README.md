# VideoStream: viewer website

The website viewers use to sign in, browse Movies, Series and Anime, and watch. It is plain HTML, CSS and JavaScript, with no build step.

The backend (API, admin dashboard, encoding) lives in a separate repository, **Video-Processing-System**. This site only talks to its viewer API:

| Path | Used for |
|---|---|
| `/api/auth/*` | Sign up, sign in, sign out |
| `/api/me/*` | My List and watch progress of the signed-in viewer |
| `/api/public/*` | The catalogue: movies, series, episodes |

The calls use relative addresses (`/api/...`), so the site must be served from the same address as the API. In production CloudFront does this: `/*` comes from this site's S3 bucket and `/api/*` goes to the server. Sharing one address keeps the login cookie simple and secure.

## Files

| File | What it is |
|---|---|
| `index.html` | The page: header, navigation, account menu slot |
| `home.js` | The app: sign-in, home rows, Movies / Series / Anime pages, series pages, the player |
| `home.css` | Styles |
| `shared/common.js` | Small helpers (escaping, toasts, dialogs, formatting) |
| `deploy.sh` | Uploads the site to S3 and refreshes CloudFront |

Routing uses the URL hash (`#/watch/<id>`, `#/series/<id>`, `#/mylist`), so any static host works with no rewrite rules.

## Run it locally

Start the backend from the Video-Processing-System repository (`npm run dev`). It serves the API on `http://localhost:5000`. Then either:

- open `http://localhost:5000/`: the backend also serves a copy of this site; or
- serve this folder with any static server that forwards `/api` to the backend.

## Deploy

The hosting (S3 bucket and CloudFront distribution) is created by Terraform in the backend repository (`terraform/website.tf`). Get the two values from there:

```bash
cd ../Video-Processing-System/terraform
terraform output website_bucket
terraform output website_distribution_id
```

Then, from this repository (Git Bash on Windows):

```bash
WEBSITE_BUCKET=<bucket> WEBSITE_DISTRIBUTION_ID=<id> ./deploy.sh
```

The site is then at `terraform output website_url` (HTTPS).

## Things to know

- Viewers must sign in. The session is an HttpOnly cookie set by the API; this code never sees it.
- My List and watch progress are saved to the viewer's account through `/api/me`. Playback speed and the chosen subtitle and audio language are kept in the browser.
- Videos stream from the video CDN (a different CloudFront address), with hls.js loaded from jsDelivr.
