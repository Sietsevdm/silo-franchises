# Silo Franchises

A self-hosted Silo sidecar. Browse TMDb movie collections and TheTVDB official lists, choose a RedHeadJedi collection poster, preview the movies and series available in selected Silo libraries, and import a manual server collection.

## Deploy in Portainer

1. Copy this directory into a Git repository that Portainer can read. In a Docker Standalone environment, select **Stacks → Add stack → Git repository**. Set the Compose path to `compose.yaml` (or `silo-franchises/compose.yaml` if the directory is nested).
2. Set `APP_PASSWORD` to a unique password with at least 16 characters. `APP_USER` defaults to `admin`.
3. Set `SILO_API_KEY` to a Silo administrator API key. If using scopes, grant only the access needed to read libraries and catalog items and to list, create, and edit server collections and upload posters. The URL defaults to your Silo server.
4. Set `TMDB_READ_TOKEN` to the **API Read Access Token** from your TMDb account. TheTVDB requires no API key. The app indexes only the [official list directory](https://thetvdb.com/lists) and checks that every selected list is in that directory before loading its members.
5. Deploy. The default host binding is `127.0.0.1:8088`. Access it through an HTTPS reverse proxy or an SSH tunnel. If the proxy runs in Docker, attach it to the app's network and forward to `silo-franchises:8080`. A plain-HTTP public port exposes the app password.

To run with Docker Compose from a shell, copy `.env.example` to `.env`, fill in the three secrets, and run `docker compose up --build -d`. Keep `.env` out of Git. For a Portainer web-editor stack, first build the image on the target Docker host with `docker build -t silo-franchises:local .`, then paste the Compose file with the `build: .` line removed. For Swarm use a prebuilt image available to the swarm rather than an in-stack build.

## How imports work

- Select a franchise and the libraries to search. The preview matches existing library entries by TMDb, TheTVDB, or IMDb ID, then by unambiguous title and year when available. It shows unmatched titles and lets you deselect matched titles before importing.
- The app downloads the public gallery artwork and uploads it to Silo as the collection poster. It uses the optimized JPEG served by the specified RedHeadJedi gallery. Browse all posters if your search terms differ from the gallery title.
- An import creates a manual Silo server collection with only the titles you select. It does not download media, change existing media metadata, or schedule future collection updates.
- Existing same-name collections in the same libraries are protected. If an import creates the collection but is interrupted during member addition or upload, retry with the same franchise, name, and library selection to resume. The app adds selected members and uploads the chosen artwork. It does not remove members from a previous attempt.
- TMDb's daily collection export, TheTVDB's public list directory, and ThePosterDB's public gallery are cached in memory. The first search after startup can take longer. TVDb and poster indexing depend on the upstream page formats and availability.

This app uses the [Silo v2 catalog API](https://github.com/Silo-Server/silo-server/blob/main/docs/catalog-api.md), [TMDb daily collection exports](https://developer.themoviedb.org/docs/daily-id-exports), and [TheTVDB official lists](https://www.thetvdb.com/lists). Artwork is credited to [RedHeadJedi on ThePosterDB](https://theposterdb.com/user/RedHeadJedi).
