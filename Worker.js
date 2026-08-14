// ── Cloudflare Worker: recept-import ──────────────────────────────────────
// Strategie:
//  1. Link  → probeer eerst gratis schema.org/JSON-LD parsing.
//  2. Link  → lukt dat niet, val terug op Claude Haiku 4.5 (tekst).
//  3. Foto  → altijd Claude Haiku 4.5 (vision) — daar is geen gratis pad voor.
//
// Secrets (`wrangler secret put <naam>`):
//   ANTHROPIC_API_KEY   → je Claude API key
//   GITHUB_TOKEN        → fine-grained PAT, alleen deze repo, Contents: Read & write
const ALLOWED_ORIGIN = "https://semvanmeurs.github.io";
const REPO = "semvanmeurs/Receptenboek";
const RECIPES_PATH = "recipes.json";
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

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

const CATEGORY_KEYWORDS = [
  ["soup", ["soep", "soup"]],
  ["dessert", ["toetje", "dessert", "gebak", "taart", "cake", "cookie"]],
  ["sauce", ["saus", "sauce", "dressing", "marinade"]],
  ["side", ["bijgerecht", "salade", "salad", "side"]],
  ["lunch", ["lunch", "broodje", "sandwich"]],
  ["fish", ["vis", "fish", "zalm", "salmon", "garnaal", "shrimp"]],
  ["vegetarian", ["vegetarisch", "vegetarian", "vegan"]],
  ["main", ["hoofdgerecht", "main", "diner", "dinner"]],
];

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
function utf8ToB64(str) { return btoa(String.fromCharCode(...new TextEncoder().encode(str))); }
function b64ToUtf8(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function slugify(text) {
  return (text || "")
    .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60) || `recept-${Date.now()}`;
}
function parseIsoDuration(iso) {
  if (!iso || typeof iso !== "string") return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return 0;
  return parseInt(m[1] || "0", 10) * 60 + parseInt(m[2] || "0", 10);
}
function textOf(val) {
  if (val == null) return "";
  if (typeof val === "string") return val.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (typeof val === "object" && val.name) return textOf(val.name);
  return String(val);
}
function flattenInstructions(instr) {
  if (!instr) return [];
  if (typeof instr === "string") return instr.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(instr)) {
    const out = [];
    for (const item of instr) {
      if (typeof item === "string") out.push(textOf(item));
      else if (item?.["@type"] === "HowToSection" && Array.isArray(item.itemListElement)) out.push(...flattenInstructions(item.itemListElement));
      else if (item?.text) out.push(textOf(item.text));
      else if (item?.name) out.push(textOf(item.name));
    }
    return out.filter(Boolean);
  }
  return [];
}
function guessCategoryId(recipeCategory, name) {
  const hay = `${textOf(recipeCategory)} ${textOf(name)}`.toLowerCase();
  for (const [id, keywords] of CATEGORY_KEYWORDS) if (keywords.some((k) => hay.includes(k))) return id;
  return "other";
}
function findRecipeNode(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) { for (const item of node) { const f = findRecipeNode(item, depth + 1); if (f) return f; } return null; }
  if (typeof node !== "object") return null;
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  if (types.includes("Recipe")) return node;
  if (node["@graph"]) return findRecipeNode(node["@graph"], depth + 1);
  if (node.mainEntity) return findRecipeNode(node.mainEntity, depth + 1);
  return null;
}
function extractJsonLdRecipe(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    let data;
    try { data = JSON.parse(block[1].trim()); } catch { continue; }
    const recipe = findRecipeNode(data);
    if (recipe) return recipe;
  }
  return null;
}
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim().slice(0, 45000);
}
async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

// ── Pad 1: gratis schema.org parsing ──────────────────────────────────────
function schemaToOurFormat(schemaRecipe, sourceUrl) {
  const title = textOf(schemaRecipe.name) || "Naamloos recept";
  const ingredients = (schemaRecipe.recipeIngredient || schemaRecipe.ingredients || []).map(textOf).filter(Boolean);
  const steps = flattenInstructions(schemaRecipe.recipeInstructions);
  if (!ingredients.length || !steps.length) return null;

  const prep = parseIsoDuration(schemaRecipe.prepTime);
  const cook = parseIsoDuration(schemaRecipe.cookTime);
  const total = parseIsoDuration(schemaRecipe.totalTime) || prep + cook;
  const categoryId = guessCategoryId(schemaRecipe.recipeCategory, title);
  let servings = schemaRecipe.recipeYield || null;
  if (Array.isArray(servings)) servings = servings[0];
  if (servings != null) servings = String(servings);

  const nl = {
    title, category: CATEGORY_LABELS[categoryId].nl,
    ingredient_groups: [{ name: "Ingrediënten", items: ingredients }],
    steps, notes: [],
  };
  return {
    id: slugify(title), category_id: categoryId, servings,
    prep_time_minutes: prep, passive_time_minutes: 0, cook_time_minutes: cook, total_time_minutes: total,
    time_estimated: !(schemaRecipe.prepTime || schemaRecipe.cookTime || schemaRecipe.totalTime),
    nl, en: { ...nl, category: CATEGORY_LABELS[categoryId].en },
    source: new URL(sourceUrl).hostname.replace(/^www\./, ""), source_url: sourceUrl, page: null,
  };
}

// ── Pad 2: Claude Haiku 4.5 (tekst-fallback en foto's) ────────────────────
const RECIPE_TOOL = {
  name: "save_recipe",
  description: "Sla het geëxtraheerde recept op in gestructureerde, tweetalige vorm.",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string" },
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
          ingredient_groups: { type: "array", items: { type: "object", properties: { name: { type: "string" }, items: { type: "array", items: { type: "string" } } }, required: ["name", "items"] } },
          steps: { type: "array", items: { type: "string" } },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["title", "ingredient_groups", "steps", "notes"],
      },
      en: {
        type: "object",
        properties: {
          title: { type: "string" },
          ingredient_groups: { type: "array", items: { type: "object", properties: { name: { type: "string" }, items: { type: "array", items: { type: "string" } } }, required: ["name", "items"] } },
          steps: { type: "array", items: { type: "string" } },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["title", "ingredient_groups", "steps", "notes"],
      },
      page: { type: ["string", "null"] },
    },
    required: ["id", "category_id", "servings", "prep_time_minutes", "passive_time_minutes", "cook_time_minutes", "total_time_minutes", "time_estimated", "nl", "en"],
  },
};
function systemPrompt() {
  return `Je haalt precies één kookrecept uit de aangeleverde bron en slaat het op via de tool save_recipe.
Regels:
- Maak zowel een Nederlandse (nl) als Engelse (en) versie. Hou het aantal ingrediëntgroepen, items per groep en stappen in beide talen exact gelijk en in dezelfde volgorde.
- Behoud hoeveelheden getrouw; verzin geen ontbrekende feiten, behalve een voorzichtige tijdschatting indien nodig (time_estimated = true).
- total_time_minutes is minimaal prep + cook.
- Negeer navigatie, advertenties en niet-recept-tekst.
- Kies exact één category_id uit: ${Object.keys(CATEGORY_LABELS).join(", ")}.
- id: lowercase-kebab-case, uniek en beschrijvend.`;
}
async function extractWithClaude(env, contentBlocks) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 4096, system: systemPrompt(),
      messages: [{ role: "user", content: contentBlocks }],
      tools: [RECIPE_TOOL], tool_choice: { type: "tool", name: "save_recipe" },
    }),
  });
  if (!r.ok) throw new Error(`Claude fout ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const data = await r.json();
  const toolUse = data.content?.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Geen gestructureerd resultaat van Claude ontvangen");
  const recipe = toolUse.input;
  if (recipe.nl) recipe.nl.category = CATEGORY_LABELS[recipe.category_id]?.nl || recipe.category_id;
  if (recipe.en) recipe.en.category = CATEGORY_LABELS[recipe.category_id]?.en || recipe.category_id;
  return recipe;
}

async function commitRecipe(env, recipe) {
  const headers = {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`, "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "recepten-api-worker",
  };
  const getRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${RECIPES_PATH}`, { headers });
  if (!getRes.ok) throw new Error(`recipes.json ophalen mislukt (${getRes.status})`);
  const getData = await getRes.json();
  const list = JSON.parse(b64ToUtf8(getData.content.replace(/\n/g, "")));
  const existingIndex = list.findIndex((r) => r.id === recipe.id);
  const action = existingIndex === -1 ? "toegevoegd" : "bijgewerkt";
  if (existingIndex === -1) list.push(recipe); else list[existingIndex] = recipe;
  const newContent = JSON.stringify(list, null, 2) + "\n";
  const putRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${RECIPES_PATH}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `Recept ${action}: ${recipe.nl.title}`, content: utf8ToB64(newContent), sha: getData.sha }),
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
    if (!env.GITHUB_TOKEN) return reply({ error: "GITHUB_TOKEN secret ontbreekt" }, 500, origin);

    try {
      const contentType = request.headers.get("content-type") || "";
      let recipe = null;
      let method = "";

      if (contentType.includes("application/json")) {
        const body = await request.json();
        if (!body.url || !/^https?:\/\//i.test(body.url)) return reply({ error: "Geldige URL ontbreekt" }, 400, origin);

        const page = await fetch(body.url, { headers: { "User-Agent": "Mozilla/5.0 RecipeImporter/1.0" } });
        if (!page.ok) return reply({ error: `Bron kon niet worden opgehaald (${page.status})` }, 400, origin);
        const html = await page.text();

        const schemaRecipe = extractJsonLdRecipe(html);
        if (schemaRecipe) recipe = schemaToOurFormat(schemaRecipe, body.url);

        if (recipe) {
          method = "gratis (schema.org)";
        } else {
          if (!env.ANTHROPIC_API_KEY) return reply({ error: "Geen gestructureerd recept gevonden op deze pagina, en geen AI-key ingesteld om het alsnog te proberen." }, 422, origin);
          const text = htmlToText(html);
          recipe = await extractWithClaude(env, [{ type: "text", text: `Bron: ${body.url}\n\nPAGINA-INHOUD:\n${text}` }]);
          recipe.source = new URL(body.url).hostname.replace(/^www\./, "");
          recipe.source_url = body.url;
          method = "AI (Claude Haiku 4.5, tekst-fallback)";
        }
      } else if (contentType.includes("multipart/form-data")) {
        if (!env.ANTHROPIC_API_KEY) return reply({ error: "Foto-import vereist de ANTHROPIC_API_KEY secret." }, 500, origin);
        const form = await request.formData();
        const files = form.getAll("images").filter((x) => x && typeof x.arrayBuffer === "function");
        if (!files.length) return reply({ error: "Geen afbeeldingen ontvangen" }, 400, origin);
        if (files.length > 5) return reply({ error: "Maximaal 5 afbeeldingen" }, 400, origin);

        const blocks = [{ type: "text", text: "Haal het recept uit deze foto's (kookboekpagina of scherm)." }];
        for (const file of files) {
          if (file.size > 5000000) return reply({ error: "Afbeelding groter dan 5 MB" }, 400, origin);
          blocks.push({ type: "image", source: { type: "base64", media_type: file.type || "image/jpeg", data: await fileToBase64(file) } });
        }
        recipe = await extractWithClaude(env, blocks);
        recipe.source = "Kookboekfoto";
        recipe.source_url = null;
        recipe.page = null;
        method = "AI (Claude Haiku 4.5, foto)";
      } else {
        return reply({ error: "Gebruik JSON voor een link of multipart/form-data voor foto's" }, 415, origin);
      }

      const action = await commitRecipe(env, recipe);
      return reply({ ok: true, action, method, recipe }, 200, origin);
    } catch (e) {
      return reply({ error: String(e?.message || e) }, 500, origin);
    }
  },
};
