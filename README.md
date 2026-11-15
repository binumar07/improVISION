# Field Shift — public demo deployment

Field Shift is a climate-adaptive crop planning and rotation decision-support prototype by improVISION.

## Deploy publicly (GitHub + Render)

This project runs a Node.js server and API. **GitHub Pages alone is not suitable** because it only hosts static files and cannot run this app's API server. Use GitHub to store the code and Render Web Service to run it.

1. Create a new **public** GitHub repository named `field-shift`.
2. Upload the contents of this folder to the repository root (not the enclosing folder).
3. In Render, choose **New → Web Service**, connect GitHub, and select `field-shift`.
4. Render can read `render.yaml`; if entering settings manually, use:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: Free
5. Deploy. Render will provide an HTTPS address ending in `onrender.com`.
6. Open that address and test the dashboard and API before sharing it.

## Meteomatics credentials (optional)

The app can use Open-Meteo without credentials. To enable Meteomatics, add `METEOMATICS_USER` and `METEOMATICS_PASSWORD` in the Render service's Environment settings. Never commit `.env` or credentials to GitHub. Do not place secrets in frontend files.

## Free-tier note

Render free web services may spin down after 15 minutes without traffic and take time to wake on the next visit. This can cause a delay on the first judge visit. Keep the deployment link ready and test it shortly before judging.

## Local run

`npm start` then open `http://localhost:3000`.
