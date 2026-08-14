// ── Cloudflare Worker: recept-import via Claude ──────────────────────────
// Secrets die je moet zetten met `wrangler secret put <naam>`:
//   ANTHROPIC_API_KEY   → je Claude API key
//   GITHUB_TOKEN        → fine-grained PAT met "Contents: read & write"
//                          op alleen deze repo (semvanmeurs/Receptenboek)
//
// Pas ALLOWED_ORIGIN aan zodra je custom domain via Cloudflare actief is.
const ALLOWED_ORIGIN = "https://semvanmeurs.github.io";
const REPO = "semvanmeurs/Receptenboek";
const RECIPES_PATH = "recipes.json";
const CLAUDE_MODEL = "claude-sonnet-5";

const CATEGORY_LABELS = {
  main: { nl: "Hoofdgerecht", en: "Main course" },
  soup: { nl: "Soep", en: "Soup" },
  lunch: { nl: "Lunch", en: "Lunch" },
  vegetarian: { nl: "Vegetarisch", en: "Vegetarian" },
  fish: { nl: "Vis", en: "Fish" },
  side: { nl: "Bijgerecht", en: "Side dish" },
  sauce: { nl: "Saus", en: "Sauce" },
  dessert: { nl: "Toetje", en: "Dessert" },
  other: { nl: "Overig", en: "Other" },
};

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin && origin.startsWith(ALLOWED_ORIGIN) ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function reply(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) },
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 45000);
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
}

function utf8ToB64(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}
function b64ToUtf8(b64) {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const RECIPE_TOOL = {
  name: "save_recipe",
  description: "Sla het geëxtraheerde recept op in gestructureerde, tweetalige vorm.",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "lowercase-kebab-case id, uniek en beschrijvend" },
      category_id: { type: "string", enum: Object.keys(CATEGORY_LABELS) },
      servings: { type: ["string", "null"] },
      prep_time_minutes: { type: "integer" },
      passive_time_minutes: { type: "integer" },
      cook_time_minutes: { type: "integer" },
      total_time_minutes: { type: "integer" },
      time_estimated: { type: "boolean" },
      nl: {
        type: "object",
        properties: {
          title: { type: "string" },
          ingredient_groups: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, items: { type: "array", items: { type: "string" } } },
              required: ["name", "items"],
            },
          },
          steps: { type: "array", items: { type: "string" } },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["title", "ingredient_groups", "steps", "notes"],
      },
      en: {
        type: "object",
        properties: {
          title: { type: "string" },
          ingredient_groups: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, items: { type: "array", items: { type: "string" } } },
              required: ["name", "items"],
            },
          },
          steps: { type: "array", items: { type: "string" } },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["title", "ingredient_groups", "steps", "notes"],
      },
      page: { type: ["string", "null"] },
    },
    required: [
      "id", "category_id", "servings", "prep_time_minutes", "passive_time_minutes",
      "cook_time_minutes", "total_time_minutes", "time_estimated", "nl", "en",
    ],
  },
};

function systemPrompt() {
  return `Je haalt precies één kookrecept uit de aangeleverde bron en slaat het op via de tool save_recipe.
Regels:
- Maak zowel een Nederlandse (nl) als Engelse (en) versie. Hou het AANTAL ingrediëntgroepen, het aantal items per groep, en het aantal stappen in beide talen exact gelijk en in dezelfde volgorde (alleen de tekst is vertaald).
- Behoud hoeveelheden getrouw; verzin geen ontbrekende feiten, behalve een voorzichtige tijdschatting indien nodig (zet dan time_estimated op true).
- total_time_minutes is minimaal prep + cook.
- Negeer navigatie, advertenties en niet-recept-tekst.
- Kies exact één category_id uit: ${Object.keys(CATEGORY_LABELS).join(", ")}.
- id: lowercase-kebab-case, uniek en beschrijvend voor dit recept.`;
}

async function extractWithClaude(env, contentBlocks) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt(),
      messages: [{ role: "user", content: contentBlocks }],
      tools: [RECIPE_TOOL],
      tool_choice: { type: "tool", name: "save_recipe" },
    }),
  });
  if (!r.ok) throw new Error(`Claude fout ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const data = await r.json();
  const toolUse = data.content?.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Geen gestructureerd resultaat van Claude ontvangen");
  return toolUse.input;
}

async function commitRecipe(env, recipe) {
  const headers = {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "recepten-api-worker",
  };

  const getRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${RECIPES_PATH}`, { headers });
  if (!getRes.ok) throw new Error(`recipes.json ophalen mislukt (${getRes.status})`);
  const getData = await getRes.json();
  const list = JSON.parse(b64ToUtf8(getData.content.replace(/\n/g, "")));

  const existingIndex = list.findIndex((r) => r.id === recipe.id);
  const action = existingIndex === -1 ? "toegevoegd" : "bijgewerkt";
  if (existingIndex === -1) list.push(recipe);
  else list[existingIndex] = recipe;

  const newContent = JSON.stringify(list, null, 2) + "\n";
  const putRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${RECIPES_PATH}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Recept ${action}: ${recipe.nl?.title || recipe.id}`,
      content: utf8ToB64(newContent),
      sha: getData.sha,
    }),
  });
  if (!putRes.ok) throw new Error(`Commit mislukt (${putRes.status}): ${(await putRes.text()).slice(0, 400)}`);
  return action;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method === "GET" && url.pathname === "/health") return reply({ ok: true, service: "recepten-api" }, 200, origin);
    if (request.method !== "POST" || url.pathname !== "/submit") return reply({ error: "Not found" }, 404, origin);
    if (!env.ANTHROPIC_API_KEY || !env.GITHUB_TOKEN) return reply({ error: "Secrets ontbreken" }, 500, origin);

    try {
      const contentType = request.headers.get("content-type") || "";
      let contentBlocks = [];
      let source = "";

      if (contentType.includes("application/json")) {
        const body = await request.json();
        if (!body.url || !/^https?:\/\//i.test(body.url)) return reply({ error: "Geldige URL ontbreekt" }, 400, origin);
        source = body.url;
        const page = await fetch(body.url, { headers: { "User-Agent": "Mozilla/5.0 RecipeImporter/1.0" } });
        if (!page.ok) return reply({ error: `Bron kon niet worden opgehaald (${page.status})` }, 400, origin);
        const text = htmlToText(await page.text());
        contentBlocks = [{ type: "text", text: `Bron: ${source}\n\nPAGINA-INHOUD:\n${text}` }];
      } else if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        const files = form.getAll("images").filter((x) => x && typeof x.arrayBuffer === "function");
        if (!files.length) return reply({ error: "Geen afbeeldingen ontvangen" }, 400, origin);
        if (files.length > 5) return reply({ error: "Maximaal 5 afbeeldingen" }, 400, origin);
        source = "Kookboekfoto";
        contentBlocks = [{ type: "text", text: "Haal het recept uit deze foto's (kookboekpagina of scherm)." }];
        for (const file of files) {
          if (file.size > 5000000) return reply({ error: "Afbeelding groter dan 5 MB" }, 400, origin);
          contentBlocks.push({
            type: "image",
            source: { type: "base64", media_type: file.type || "image/jpeg", data: await fileToBase64(file) },
          });
        }
      } else {
        return reply({ error: "Gebruik JSON voor een link of multipart/form-data voor foto's" }, 415, origin);
      }

      const recipe = await extractWithClaude(env, contentBlocks);
      recipe.source = source;
      recipe.source_url = source.startsWith("http") ? source : null;
      if (recipe.nl) recipe.nl.category = CATEGORY_LABELS[recipe.category_id]?.nl || recipe.category_id;
      if (recipe.en) recipe.en.category = CATEGORY_LABELS[recipe.category_id]?.en || recipe.category_id;

      const action = await commitRecipe(env, recipe);
      return reply({ ok: true, action, recipe }, 200, origin);
    } catch (e) {
      return reply({ error: String(e?.message || e) }, 500, origin);
    }
  },
};
