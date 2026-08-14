const ALLOWED_ORIGIN = "https://semvanmeurs.github.io";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin && origin.startsWith(ALLOWED_ORIGIN) ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function reply(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) }
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

async function toDataUrl(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return `data:${file.type || "image/jpeg"};base64,${btoa(binary)}`;
}

function prompt(source) {
  return `Extract one cooking recipe from the supplied source. Return ONLY valid JSON, no markdown.
Create Dutch and English versions. Preserve quantities faithfully. Do not invent missing facts except a conservative time estimate when necessary.
Choose exactly one category_id: main, soup, lunch, vegetarian, fish, side, sauce, dessert, other.
Schema:
{
  "id":"lowercase-kebab-id",
  "category_id":"main",
  "servings":"4 personen or null",
  "prep_time_minutes":0,
  "passive_time_minutes":0,
  "cook_time_minutes":0,
  "total_time_minutes":0,
  "time_estimated":true,
  "nl":{"title":"","category":"","ingredient_groups":[{"name":"","items":[""]}],"steps":[""],"notes":[""]},
  "en":{"title":"","category":"","ingredient_groups":[{"name":"","items":[""]}],"steps":[""],"notes":[""]},
  "source":"${source.replace(/"/g, '\\"')}",
  "source_url":null
}
Rules: translate naturally; total_time_minutes must be at least prep + cook; ignore navigation, ads and unrelated text.`;
}

async function extractWithOpenAI(env, content) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      input: [{ role: "user", content }]
    })
  });
  if (!r.ok) throw new Error(`OpenAI fout ${r.status}: ${(await r.text()).slice(0,400)}`);
  const data = await r.json();
  if (!data.output_text) throw new Error("Geen tekstresultaat van OpenAI");
  return JSON.parse(data.output_text);
}

async function createSubmissionIssue(env, recipe, note) {
  const title = `[submission] ${recipe?.nl?.title || recipe?.en?.title || recipe.id || "Nieuw recept"}`;
  const body = [
    "Publieke receptinzending via recepten-api.",
    note ? `Opmerking indiener: ${note}` : "",
    "",
    "```json",
    JSON.stringify(recipe, null, 2),
    "```"
  ].filter(Boolean).join("\n");

  const r = await fetch("https://api.github.com/repos/semvanmeurs/Receptenboek/issues", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "recepten-api-worker",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ title, body })
  });
  if (!r.ok) throw new Error(`GitHub fout ${r.status}: ${(await r.text()).slice(0,400)}`);
  return r.json();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method === "GET" && url.pathname === "/health") return reply({ ok: true, service: "recepten-api" }, 200, origin);
    if (request.method !== "POST" || url.pathname !== "/submit") return reply({ error: "Not found" }, 404, origin);
    if (!env.OPENAI_API_KEY || !env.GITHUB_TOKEN) return reply({ error: "Secrets ontbreken" }, 500, origin);

    try {
      const contentType = request.headers.get("content-type") || "";
      let content = [];
      let source = "";
      let note = "";

      if (contentType.includes("application/json")) {
        const body = await request.json();
        if (!body.url || !/^https?:\/\//i.test(body.url)) return reply({ error: "Geldige URL ontbreekt" }, 400, origin);
        source = body.url;
        note = String(body.note || "").slice(0,500);
        const page = await fetch(body.url, { headers: { "User-Agent": "Mozilla/5.0 RecipeImporter/1.0" } });
        if (!page.ok) return reply({ error: `Bron kon niet worden opgehaald (${page.status})` }, 400, origin);
        const text = htmlToText(await page.text());
        content = [
          { type: "input_text", text: prompt(source) },
          { type: "input_text", text: `SOURCE CONTENT:\n${text}` }
        ];
      } else if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        note = String(form.get("note") || "").slice(0,500);
        const files = form.getAll("images").filter(x => x && typeof x.arrayBuffer === "function");
        if (!files.length) return reply({ error: "Geen afbeeldingen ontvangen" }, 400, origin);
        if (files.length > 5) return reply({ error: "Maximaal 5 afbeeldingen" }, 400, origin);
        source = "Cookbook photo submission";
        content = [{ type: "input_text", text: prompt(source) }];
        for (const file of files) {
          if (file.size > 5000000) return reply({ error: "Afbeelding groter dan 5 MB" }, 400, origin);
          content.push({ type: "input_image", image_url: await toDataUrl(file) });
        }
      } else {
        return reply({ error: "Gebruik JSON voor een link of multipart/form-data voor foto's" }, 415, origin);
      }

      const recipe = await extractWithOpenAI(env, content);
      if (source.startsWith("http")) recipe.source_url = source;
      const issue = await createSubmissionIssue(env, recipe, note);
      return reply({ ok: true, issue_number: issue.number, preview: recipe }, 200, origin);
    } catch (e) {
      return reply({ error: String(e?.message || e) }, 500, origin);
    }
  }
};
