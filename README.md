# Netherlands Rental Listings MCP Server

[![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-dutch-rental-listings)](https://www.npmjs.com/package/@mambalabsdev/mcp-dutch-rental-listings) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-dutch-rental-listings)](https://github.com/mambalabsdev/mcp-dutch-rental-listings/blob/main/LICENSE)

An MCP server for the Mamba Labs Netherlands Rental Listings actor on Apify. One deduplicated list of Dutch rentals, with registration status.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Tool](#tool)
- [Inputs](#inputs)
- [Pricing](#pricing)
- [Full actor documentation](#full-actor-documentation)
- [License](#license)

## What it does

Give a Dutch city, province, or the whole country. The actor reads Kamernet, HousingAnywhere, and 11 anti-squat agency sites over plain HTTP, merges them into one list without repeats, and returns rent, size, type, registration status with the proving sentence, hide reasons, and first seen and last seen per listing. It does not cover Pararius, Huurwoningen, Funda, or Gapph.

All of the work runs on Apify. This package is a thin client that starts the actor run, waits for it, and hands back the dataset rows.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config (`claude_desktop_config.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "mamba-dutch-rental-listings": {
      "command": "npx",
      "args": [
        "-y",
        "@mambalabsdev/mcp-dutch-rental-listings"
      ],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Restart the client. The `search_dutch_rental_listings` tool appears.

## Prerequisites

- Node.js 18 or newer.
- An Apify API token from [console.apify.com/account/integrations](https://console.apify.com/account/integrations), set as `APIFY_TOKEN`. The server lists its tool without a token; a call needs one.

## Example prompts

- "Find rooms in Utrecht under 800 euros a month."
- "List new anti-squat places in Noord-Holland since my last search."
- "Show Amsterdam studios where municipal registration is possible."

## Tool

`search_dutch_rental_listings`. One tool. Example arguments:

```json
{
  "location": "Utrecht",
  "sources": [
    "kamernet",
    "housinganywhere"
  ],
  "maxResults": 20
}
```

## Inputs

Every buyer facing input of the actor. Omitted inputs take the actor's own defaults.

| Input | Type | Required | Description |
|---|---|---|---|
| `location` | string | no | A Dutch city (Kamernet's 212 cities, such as Utrecht or Den Haag), a province as province:noord-holland, or netherlands for the whole country. A bare name that is both a city and a province (Utrecht, Groningen) is the city. |
| `radiusKm` | number | no | Kamernet only: also search this far around the city. 0, 1, 2, 5, 10 (default), or 20; other values round up. HousingAnywhere and the agencies search the city itself. |
| `sources` | array | no | kamernet, housinganywhere, antisquat_agencies (11 Dutch anti-squat agency sites). Default: all three. |
| `propertyTypes` | array | no | Keep only these: room, studio, apartment, house, anti-squat, student-residence, other. Empty keeps all. |
| `maxResults` | number | no | Listings to return as charged rows. Default 50. |
| `maxRent` | number | no | Drop listings above this rent. A listing with no rent stays. |
| `minSize` | number | no | Drop listings smaller than this. A listing with no size stays. |
| `minRooms` | number | no | Drop listings with fewer rooms. Kamernet states rooms only on the detail page, so this works there with includeDetails on. |
| `furnished` | array | no | Keep only these: furnished, unfurnished, uncarpeted. A listing that does not say stays. |
| `registrationOnly` | boolean | no | true: keep only listings whose text or listed field says municipal registration is possible (registration_status yes, listed_yes, or flag). Text needs includeDetails on. |
| `availableBy` | string | no | YYYY-MM-DD. Drop listings available only after this day. A listing with no date stays. |
| `hasInternet` | string | no | Kamernet's own filter, sent with the search. |
| `privateBathroom` | string | no | Kamernet's own filter. |
| `privateKitchen` | string | no | Kamernet's own filter. |
| `privateToilet` | string | no | Kamernet's own filter. |
| `petsAllowed` | string | no | Kamernet's own filter. |
| `smokingAllowed` | string | no | Kamernet's own filter. |
| `numberOfPeople` | string | no | Kamernet's own filter: 1 to 5 tenants. |
| `tenantGender` | string | no | Kamernet's own filter: male or female. |
| `tenantAge` | number | no | Kamernet's own filter: your age in years, 16 to 99. |
| `roommatesMax` | string | no | Kamernet's own filter: none, up_to_4, or up_to_8. |
| `roommateGenders` | array | no | Kamernet's own filter: male, female, mixed. |
| `landlordTypes` | array | no | Kamernet's own filter: private, agent. |
| `includeDetails` | boolean | no | true: read each returned listing's detail page for the full text, house rules, landlord type, deposit, and the text based registration and hide rules. Charged per page read. Default false. |
| `includeLandlordName` | string | no | true: add the landlord's display name. Off by default, because on Kamernet most landlords are private people. |
| `blockedLandlordIds` | array | no | Landlord account IDs (landlord_id) whose listings are returned as free hidden_listing rows instead of charged rows. |
| `excludeGenderOnly` | boolean | no | true: a listing whose text limits it to one gender becomes a free hidden_listing row with the matched sentence. false: it is returned with the reason in hide_reasons. |
| `excludeLanguageOnly` | boolean | no | true: a listing whose text limits it to Dutch or Polish speakers becomes a free hidden_listing row. |
| `excludeStudentOnly` | boolean | no | true: a listing whose text limits it to students becomes a free hidden_listing row. |
| `excludeShortStay` | boolean | no | true: a listing whose text or listed maximum stay is under 3 months becomes a free hidden_listing row. |
| `trackChanges` | boolean | no | true (default): keep first seen and last seen for this search in a named key-value store in your own Apify account, so later runs mark new and stale listings. |
| `draftMessages` | boolean | no | true: write a first message to each landlord with your own model key and applicantProfile. Turns on includeDetails. Needs llmApiKey; without one the run fails with a plain error. |
| `llmProvider` | string | no | openai (default), anthropic, gemini, or groq. Used only with draftMessages. |
| `llmApiKey` | string | no | Your own key for the provider above. It goes only to that provider, is never stored or logged, and is never sent to the model. |
| `llmModel` | string | no | A model name from your provider. Empty uses gpt-4o-mini, claude-haiku-4-5-20251001, gemini-2.5-flash, or llama-3.3-70b-versatile. |
| `applicantProfile` | string | no | Facts about you for the drafts, as JSON such as {"name": "Sam", "age": 29, "work": "software engineer", "move_in": "2026-12-01", "contact": "sam@example.com"} or plain lines. The model restates only these facts. |
| `maxDrafts` | number | no | Most messages to draft in one run. Default 20. |
| `max_charge_usd` | string | no | Optional. The run stops before a charge that would pass this amount. Free rows are always returned. |

## Pricing

Pay per event on Apify, billed to your Apify account. Prices in USD.

| Event | Free plan | Bronze | Silver | Gold |
|---|---|---|---|---|
| `listing-row`, one listing | $0.0011 | $0.001045 | $0.00099 | $0.000935 |
| `detail-page`, one detail page read, with includeDetails on | $0.002 | $0.0019 | $0.0018 | $0.0017 |
| `message-draft`, one message drafted on your own key, with draftMessages on | $0.003 | $0.00285 | $0.0027 | $0.00255 |
| `apify-actor-start`, per run start | $0.012 | $0.012 | $0.012 | $0.012 |

Hidden listings, source status rows, failed drafts, and refused input are free. Mamba Labs pays the platform costs of the run. Mamba Labs pays the platform costs of the run, Apify proxy traffic included.

## Full actor documentation

[apify.com/mambalabs/dutch-rental-listings](https://apify.com/mambalabs/dutch-rental-listings)

## License

MIT. See [LICENSE](LICENSE).
