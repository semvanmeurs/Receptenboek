#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

REQUIRED = {
    'id': str,
    'title': str,
    'category': str,
    'servings': (str, type(None)),
    'prep_time_minutes': int,
    'passive_time_minutes': int,
    'cook_time_minutes': int,
    'total_time_minutes': int,
    'time_estimated': bool,
    'ingredient_groups': list,
    'steps': list,
    'source': str,
    'page': (str, type(None)),
    'notes': list,
}


def fail(msg: str):
    print(f'ERROR: {msg}', file=sys.stderr)
    sys.exit(1)


def extract_json(body: str):
    start_marker = '```json'
    end_marker = '```'
    start = body.find(start_marker)
    if start == -1:
        fail('Geen ```json codeblok gevonden in issue body.')
    start += len(start_marker)
    end = body.find(end_marker, start)
    if end == -1:
        fail('JSON codeblok is niet afgesloten.')
    raw = body[start:end].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        fail(f'Ongeldige JSON: {e}')


def validate(recipe: dict):
    if not isinstance(recipe, dict):
        fail('Recept moet een JSON-object zijn.')
    for key, typ in REQUIRED.items():
        if key not in recipe:
            fail(f'Verplicht veld ontbreekt: {key}')
        if not isinstance(recipe[key], typ):
            fail(f'Veld {key} heeft onjuist type: {type(recipe[key]).__name__}')
    if not recipe['id'] or not recipe['title']:
        fail('id en title mogen niet leeg zijn.')
    if not all(isinstance(x, str) and x.strip() for x in recipe['steps']):
        fail('Alle stappen moeten niet-lege strings zijn.')
    for group in recipe['ingredient_groups']:
        if not isinstance(group, dict) or set(group.keys()) != {'name', 'items'}:
            fail('Elke ingredient_group moet exact name en items bevatten.')
        if not isinstance(group['name'], str) or not group['name'].strip():
            fail('Ingredientgroepnaam mag niet leeg zijn.')
        if not isinstance(group['items'], list) or not all(isinstance(x, str) and x.strip() for x in group['items']):
            fail('Ingredientgroep items moeten niet-lege strings zijn.')
    for k in ['prep_time_minutes','passive_time_minutes','cook_time_minutes','total_time_minutes']:
        if recipe[k] < 0:
            fail(f'{k} mag niet negatief zijn.')
    if recipe['total_time_minutes'] < recipe['prep_time_minutes'] + recipe['cook_time_minutes']:
        fail('total_time_minutes is lager dan prep + cook.')


def main():
    body = os.environ.get('ISSUE_BODY', '')
    repo_root = Path(os.environ.get('GITHUB_WORKSPACE', '.'))
    recipes_path = repo_root / 'recipes.json'
    if not recipes_path.exists():
        fail(f'{recipes_path} bestaat niet.')

    recipe = extract_json(body)
    validate(recipe)

    data = json.loads(recipes_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        fail('recipes.json moet een array zijn.')

    existing = next((i for i, r in enumerate(data) if r.get('id') == recipe['id']), None)
    action = 'toegevoegd'
    if existing is None:
        data.append(recipe)
    else:
        data[existing] = recipe
        action = 'bijgewerkt'

    recipes_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Recept {recipe["id"]} {action}.')


if __name__ == '__main__':
    main()
