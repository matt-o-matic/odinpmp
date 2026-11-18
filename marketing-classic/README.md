# Odin marketing site, classic design

The marketing site as it was before the October 2026 redesign, kept so it can still be run or restored. It isn't deployed: the deploy builds and serves `marketing/`.

```
npm install --prefix marketing-classic
npm run dev:marketing-classic     # localhost:2282
npm run build:marketing-classic   # marketing-classic/dist
```

Known issue, left as it was: its sign-up page posts to `http://localhost:3001` unless `PUBLIC_API_BASE_URL` is set at build time, so the form doesn't work in a production build.
