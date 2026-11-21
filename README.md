# Silo Franchises

A self-hosted Silo sidecar. Browse TMDb movie collections and TheTVDB official lists, choose a ThePosterDB collection poster, preview the movies and series available in selected Silo libraries, and import a manual server collection.

## Deploy in Portainer

1. Copy this directory into a Git repository that Portainer can read. In a Docker Standalone environment, select **Stacks → Add stack → Git repository**. Set the Compose path to `compose.yaml` (or `silo-franchises/compose.yaml` if the directory is nested).
2. Set `APP_PASSWORD` to a unique password with at least 16 characters. `APP_USER` defaults to `admin`.
3. Set `SILO_API_KEY` to a Silo administrator API key. If using scopes, grant only the access needed to read libraries and catalog items and to list, create, and edit server collections and upload posters. The URL defaults to your Silo server.
4. Set `TMDB_READ_TOKEN` to the **API Read Access Token** from your TMDb account. TheTVDB requires no API key. The app indexes only the [official list directory](https://thetvdb.com/lists) and checks that every selected list is in that directory before loading its members.
5. Deploy. The default host binding is `127.0.0.1:8088`. Access it through an HTTPS reverse proxy or an SSH tunnel. If the proxy runs in Docker, attach it to the app's network and forward to `silo-franchises:8080`. A plain-HTTP public port exposes the app password.

To run with Docker Compose from a shell, copy `.env.example` to `.env`, fill in the three secrets, and run `docker compose up --build -d`. Keep `.env` out of Git. For a Portainer web-editor stack, first build the image on the target Docker host with `docker build -t silo-franchises:local .`, then paste the Compose file with the `build: .` line removed. For Swarm use a prebuilt image available to the swarm rather than an in-stack build.

## How imports work

- **Movies** and **TV** open separate pages. Official lists that span both media types are filtered to movies or series before matching. The movie page also offers TMDb.
- TV descriptions come from TheTVDB and remain editable. TV backdrops start blank. To add one, enter a direct public HTTPS image URL.
- Movie descriptions and backdrops come from TMDb. Open **Browse movie backdrops** for images from the individual films. Movies listed on TheTVDB use a related TMDb film for the initial description and artwork.
- **Keep collection synced with TMDb** is available for TMDb movie franchises. It creates a native Silo TMDb-backed collection with a daily sync. The first sync runs immediately. Silo must have its own TMDb integration configured. The two-title minimum still applies to each selected library when creating it.
- Select multiple checkboxes and choose **Prepare selected** to check them against the selected libraries. An unambiguous exact match on the first poster page is suggested automatically. Open unfinished entries to choose artwork, then choose **Save to bulk queue**. **Preview bulk changes** checks queued entries without writing to Silo. **Apply ready** submits eligible entries. **Bulk history** keeps recent outcomes and lets you retry individual failures in the same browser.
- Use **In Silo** or an **In Silo · Edit** badge to change a collection's name, description, or artwork. For manual collections with a known franchise source, preview matches and select titles to append to the collection.
- **Queue changes** adds an existing-collection edit to the bulk queue. Open the queue entry to revise it or select **Apply ready** to save it in Silo.

- Select a franchise and the libraries to search. The preview matches existing library entries by TMDb, TheTVDB, or IMDb ID, then by unambiguous title and year when available. It shows unmatched titles and lets you deselect matched titles before importing.
- The **Poster source** menu searches English-language collection artwork from RedHeadJedi, ishalioh, ashlyfxxk, XDM, mikenobbs, DarkMatte, DIIIVOY, cmanuelg1989, KyleKahotek, and j.zapattack. Select one creator or search all ten together. Every result shows the creator. The app uploads the optimized JPEG from the selected public gallery to Silo.
- **Custom poster URL** previews an image from a direct public HTTPS link and selects it for upload. **In Silo → Sort collections A–Z in Silo** updates the display order within each collection group in the selected library. **Hide collections already in Silo** filters the franchise browser while keeping the **In Silo** editor available.
- Save named library presets separately for Movies and TV in the current browser. **Missing titles** lists unmatched and ambiguous entries. Use **Match manually** to search the selected libraries and choose a replacement for an individual franchise member before saving a manual collection.
- The preview shows every selected library that contains each match. For new collections, a library qualifies only when it contains at least two distinct selected titles. A collection can span the qualifying libraries. The same minimum applies to movie and TV imports, including the bulk queue.
- An import creates a manual Silo server collection with only the selected titles from qualifying libraries. It does not download media, change existing media metadata, or schedule future collection updates.
- Sort by title on either page or by star count when browsing TheTVDB.
- Existing same-name collections in the same libraries are protected. If an import creates the collection but is interrupted during member addition or upload, retry with the same franchise, name, and library selection to resume. The app adds selected members and uploads the chosen artwork. It does not remove members from a previous attempt.
- TMDb's daily collection export, TheTVDB's public list directory, and ThePosterDB's public gallery pages are cached in memory. Poster search loads pages progressively. Library previews fetch franchise details and library inventory concurrently and reuse complete inventories for up to ten minutes. Cold requests still depend on the size of your libraries and upstream response times.

This app uses the [Silo v2 catalog API](https://github.com/Silo-Server/silo-server/blob/main/docs/catalog-api.md), [TMDb daily collection exports](https://developer.themoviedb.org/docs/daily-id-exports), and [TheTVDB official lists](https://www.thetvdb.com/lists). Poster cards credit their [ThePosterDB](https://theposterdb.com/) creators.
