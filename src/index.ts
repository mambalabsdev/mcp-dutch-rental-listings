#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. Fleet standard
// (standing build rule 5, 2026-10-05). A run of 50 searches of 100 posts each
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

// The actor's number and on or off inputs are text fields (Apify checks input
// types before the actor starts, and Clay sends text), so numbers and booleans
// from the model are sent as text.
function asActorInput(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(compact(args))) {
    out[k] = typeof v === "number" || typeof v === "boolean" ? String(v) : v;
  }
  return out;
}

const server = new McpServer({
  name: "mamba-dutch-rental-listings",
  version: pkg.version,
});

// Dutch Rental Listings (immutable actor ID sGKGsbwoX18lFb6dR). Every buyer facing input of the actor is exposed.
server.registerTool(
  "search_dutch_rental_listings",
  {
    title: "Search Dutch rental listings",
    description:
      "Search Kamernet, HousingAnywhere, and 11 Dutch anti-squat agency sites for one city, province, or the whole Netherlands. Returns one deduplicated list with rent, size, type, municipal registration status with the proving sentence, hide reasons, and new since last run flags. Detail pages and landlord message drafts on your own model key are optional. Pararius, Huurwoningen, and Funda are not covered. Pay per event on Apify.",
    annotations: {
      title: "Search Dutch rental listings",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      location: z.string().optional().describe("A Dutch city (Kamernet's 212 cities, such as Utrecht or Den Haag), a province as province:noord-holland, or netherlands for the whole country. A bare name that is both a city and a province (Utrecht, Groningen) is the city."),
      radiusKm: z.number().optional().describe("Kamernet only: also search this far around the city. 0, 1, 2, 5, 10 (default), or 20; other values round up. HousingAnywhere and the agencies search the city itself."),
      sources: z.array(z.string()).optional().describe("kamernet, housinganywhere, antisquat_agencies (11 Dutch anti-squat agency sites). Default: all three."),
      propertyTypes: z.array(z.string()).optional().describe("Keep only these: room, studio, apartment, house, anti-squat, student-residence, other. Empty keeps all."),
      maxResults: z.number().optional().describe("Listings to return as charged rows. Default 50."),
      maxRent: z.number().optional().describe("Drop listings above this rent. A listing with no rent stays."),
      minSize: z.number().optional().describe("Drop listings smaller than this. A listing with no size stays."),
      minRooms: z.number().optional().describe("Drop listings with fewer rooms. Kamernet states rooms only on the detail page, so this works there with includeDetails on."),
      furnished: z.array(z.string()).optional().describe("Keep only these: furnished, unfurnished, uncarpeted. A listing that does not say stays."),
      registrationOnly: z.boolean().optional().describe("true: keep only listings whose text or listed field says municipal registration is possible (registration_status yes, listed_yes, or flag). Text needs includeDetails on."),
      availableBy: z.string().optional().describe("YYYY-MM-DD. Drop listings available only after this day. A listing with no date stays."),
      hasInternet: z.enum(["false","true"]).optional().describe("Kamernet's own filter, sent with the search."),
      privateBathroom: z.enum(["false","true"]).optional().describe("Kamernet's own filter."),
      privateKitchen: z.enum(["false","true"]).optional().describe("Kamernet's own filter."),
      privateToilet: z.enum(["false","true"]).optional().describe("Kamernet's own filter."),
      petsAllowed: z.enum(["false","true"]).optional().describe("Kamernet's own filter."),
      smokingAllowed: z.enum(["false","true"]).optional().describe("Kamernet's own filter."),
      numberOfPeople: z.enum(["1","2","3","4","5"]).optional().describe("Kamernet's own filter: 1 to 5 tenants."),
      tenantGender: z.enum(["male","female"]).optional().describe("Kamernet's own filter: male or female."),
      tenantAge: z.number().optional().describe("Kamernet's own filter: your age in years, 16 to 99."),
      roommatesMax: z.enum(["none","up_to_4","up_to_8"]).optional().describe("Kamernet's own filter: none, up_to_4, or up_to_8."),
      roommateGenders: z.array(z.string()).optional().describe("Kamernet's own filter: male, female, mixed."),
      landlordTypes: z.array(z.string()).optional().describe("Kamernet's own filter: private, agent."),
      includeDetails: z.boolean().optional().describe("true: read each returned listing's detail page for the full text, house rules, landlord type, deposit, and the text based registration and hide rules. Charged per page read. Default false."),
      includeLandlordName: z.enum(["false","true"]).optional().describe("true: add the landlord's display name. Off by default, because on Kamernet most landlords are private people."),
      blockedLandlordIds: z.array(z.string()).optional().describe("Landlord account IDs (landlord_id) whose listings are returned as free hidden_listing rows instead of charged rows."),
      excludeGenderOnly: z.boolean().optional().describe("true: a listing whose text limits it to one gender becomes a free hidden_listing row with the matched sentence. false: it is returned with the reason in hide_reasons."),
      excludeLanguageOnly: z.boolean().optional().describe("true: a listing whose text limits it to Dutch or Polish speakers becomes a free hidden_listing row."),
      excludeStudentOnly: z.boolean().optional().describe("true: a listing whose text limits it to students becomes a free hidden_listing row."),
      excludeShortStay: z.boolean().optional().describe("true: a listing whose text or listed maximum stay is under 3 months becomes a free hidden_listing row."),
      trackChanges: z.boolean().optional().describe("true (default): keep first seen and last seen for this search in a named key-value store in your own Apify account, so later runs mark new and stale listings."),
      draftMessages: z.boolean().optional().describe("true: write a first message to each landlord with your own model key and applicantProfile. Turns on includeDetails. Needs llmApiKey; without one the run fails with a plain error."),
      llmProvider: z.enum(["openai","anthropic","gemini","groq"]).optional().describe("openai (default), anthropic, gemini, or groq. Used only with draftMessages."),
      llmApiKey: z.string().optional().describe("Your own key for the provider above. It goes only to that provider, is never stored or logged, and is never sent to the model."),
      llmModel: z.string().optional().describe("A model name from your provider. Empty uses gpt-4o-mini, claude-haiku-4-5-20251001, gemini-2.5-flash, or llama-3.3-70b-versatile."),
      applicantProfile: z.string().optional().describe("Facts about you for the drafts, as JSON such as {\"name\": \"Sam\", \"age\": 29, \"work\": \"software engineer\", \"move_in\": \"2026-12-01\", \"contact\": \"sam@example.com\"} or plain lines. The model restates only these facts."),
      maxDrafts: z.number().optional().describe("Most messages to draft in one run. Default 20."),
      max_charge_usd: z.string().optional().describe("Optional. The run stops before a charge that would pass this amount. Free rows are always returned."),
    },
  },
  async (args) => runActor("sGKGsbwoX18lFb6dR", "Dutch Rental Listings", asActorInput(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
