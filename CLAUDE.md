# Маркетплейс плагинов Claude Code

Манифест: `.claude-plugin/marketplace.json`. Плагины лежат в `plugins/<name>/`, в `source` пиши `"./plugins/<name>"`.

## Добавление плагина

1. `plugins/<name>/.claude-plugin/plugin.json` — `name`, `description`, `version`.
2. Компоненты в корне плагина (не внутри `.claude-plugin/`): `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`.
3. Запись в `plugins[]` маркетплейса + строка в разделе «Плагины» README.
4. `claude plugin validate .` и `claude plugin validate plugins/<name>` проходят без ошибок.
5. Для модов (плагинов с `hooks/register.tsx`) — `claude plugin test plugins/<name>` зелёный.

## Правила

- При изменении поведения плагина поднимай `version` в его `plugin.json` — иначе у пользователей не обновится кэш.
- В путях внутри плагина используй `${CLAUDE_PLUGIN_ROOT}`, не абсолютные пути.
