# Аудит документации (`docs-cassowary`)

Дата аудита: 2026-11-15. Проверены корневой `README.md`, все файлы в `docs/`, `docs/architecture-rebuild/`, `docs/proposals/` и `docs/audits/`.

---

## 1. Единственный дом (`Sole-Home Table`)

| Закон / концепция | Канонический документ |
| --- | --- |
| Словарь терминов, контуры `Local`/`Server`, 3-DB изоляция, `inhuman`-плагины, `Project` и `Kill-List` | [thesaurus.md](thesaurus.md) |
| Целевая архитектура клиент+сервер, целевые таблицы БД, `AsyncDisposable`-иерархия, `FS/shell` плагин и DAG волн 0–5 | [unified-architecture.md](unified-architecture.md) |
| Требования к быстродействию (SLO), методика `T_actual / T_floor` и базовые замеры *(добавляется в Волне 0.5)* | `docs/architecture/performance-requirements.md` |
| Живая модель цикла `ReAct` / `CodeAct`, бюджетов и восстановления раунда | [../react-round-lifecycle.md](../react-round-lifecycle.md) |
| Изоляция встраиваемого `@inhuman.tools/turn/runtime` и контракт с `kley` | [../proposals/session-runtime-isolation.md](../proposals/session-runtime-isolation.md) |
| Реверс-туннель `inhuman login` через `harness.inhuman.tools` | [../proposals/remote-access.md](../proposals/remote-access.md) |
| Линии тестирования и правила упаковки публичных пакетов | [../testing.md](../testing.md), [../package-guidelines.md](../package-guidelines.md) |

---

## 2. Полная инвентаризация и статус дрейфа

| Документ | Категория | Статус и найденный дрейф | Действие |
| --- | --- | --- | --- |
| [../../README.md](../../README.md) | Публичный вход | Описывает локальный CLI/Web продукт (`npx inhuman`). Актуален для `Local Contour`; после Волны 5 дополнить ссылкой на переносимую серверную поставку | Оставить без изменений до Волны 5 |
| [../usage.md](../usage.md) | Руководство оператора | Актуально для `Local Contour` (`~/.harness`, `manual`/`auto`/`yolo`). Упоминание «Closing either client ... this is not cloud execution» остается верным для локального режима | Сохранить как операторский гайд CLI |
| [../packages.md](../packages.md) | Карта пакетов | Обновлено в Волне 1 (`scope-plane` публичный с каноническим 11-табличным `RowPlane`; приватные адаптеры `scope-plane-electric`, `scope-plane-tinybase`) | Остальные пакеты дообновить в Волне 5 |
| [../package-guidelines.md](../package-guidelines.md) | Стандарт пакетов | Актуален | Сохранить |
| [../testing.md](../testing.md) | Инженерная спецификация | Актуален; в Волне 0.5 дополнить ссылкой на стандартные бенчмарки | Дополнить после Волны 0.5/1 |
| [../react-round-lifecycle.md](../react-round-lifecycle.md) | Спецификация рантайма | **Частичный дрейф лексики**: строки 24, 114, 124–126 по-прежнему ссылаются на `Plexus syncing action`, `MobX actions alone do not make Yjs updates atomic`, `Yjs update` и `DocumentService` вместо `DocumentContainer.transact` | Обновить формулировки синхронизации после Волны 2 |
| [../proposals/remote-access.md](../proposals/remote-access.md) | Пропозал / эксплуатация | **Устаревший транспорт**: строки 23–36, 55, 80 описывают `Y.Doc` и `Yjs binary` в `MachineDO` вместо фреймов `ShapeDeltaFrame` / узлов | Актуализировать или пометить `MachineDO` транспорт в Волне 5 |
| [../proposals/session-runtime-isolation.md](../proposals/session-runtime-isolation.md) и [review](../proposals/session-runtime-isolation-review.md) | Исторический пропозал v0.1→candidate | Зафиксировал встраиваемый `@inhuman.tools/turn/runtime` и первый этап отказа от Yjs-монолита; таблица `ScopePlane`/`Kley` в разделе контекста относится к волне до единой `Agent DB` | Сохранить как исторический контекст; целевой дизайн — в [unified-architecture.md](unified-architecture.md) |
| [../proposals/live-reasoning-and-loop-state.md](../proposals/live-reasoning-and-loop-state.md) | Активный драфт (working tree) | Соответствует новому стеку (`session_nodes` -> `UpdateLaneHub` -> `shape/delta`, `presence/update`) | Не трогать (принадлежит параллельной задаче) |
| [../graphic-precision.md](../graphic-precision.md), [web-rebuild](../graphic-precision-web-rebuild.md), [component-coverage](../graphic-precision-component-coverage.md) | UI-дизайн система | Ортогональны слою БД и демона, актуальны для Web UI | Сохранить |
| [../audits/2026-11-12-architecture-audit.md](../audits/2026-11-12-architecture-audit.md) | Точечный аудит (non-public/snapshot) | Ценная фиксация багов границ на 2026-11-12 (дрейф `'ask'` vs `'manual'`, фейковый `readOnly` на клиенте, `L2` импорты `statusline`/`activity` из `harness-model`, in-process плагинный jail). Часть находок уже решается в текущих волнах | Оставить как снимок-аудит; ключевые фиксы включены в Волны 1–4 |
| `docs/architecture-rebuild/00` … `11` | Исторический план пересборки | **Существенный дрейф относительно реального кода и серверных требований**:<br>1. План проектировал `session_updates (revision, patch_json)`, тогда как в коде уже реализована таблица `session_nodes` (`sqlite.ts`) + `DocumentContainer.applyNodeRows` (`LiveShape`).<br>2. План сохранял `kernel_state.id = 'singleton'` и `permission_mode = 'ask'`.<br>3. В узлах 04–07 не было разделения 3 БД (`Product` / `Agent` / `Secrets`), отказа от `KernelReflector` на сервере, `Symbol.asyncDispose` архивации и модели `Project` с `pluginConfigs` + выносом `FS/shell` в плагин.<br>4. Узел 11 предполагал хранение агентских сессий внутри team DB `kley` вместо выделенной мульти-тенантной `Agent DB`. | В Волне 0 помечен редирект в [00-strategy-and-dag.md](../architecture-rebuild/00-strategy-and-dag.md); единый канон перенесен в [unified-architecture.md](unified-architecture.md) |

---

## 3. Противоречия в коде, выявленные при сведении с документацией

Эти расхождения напрямую закрываются Волнами 1–5:

1. ~~**Две конкурирующие схемы внутри `packages/scope-plane`**~~ *(закрыто в Волне 1)*:
   - единая 11-табличная мульти-тенантная схема зафиксирована в каноническом контракте ([tables.ts](../../packages/harness-contract/src/schema/tables.ts), [sqlite.ts](../../packages/harness-contract/src/schema/sqlite.ts), [postgres.ts](../../packages/harness-contract/src/schema/postgres.ts));
   - старая 10-табличная схема в `packages/scope-plane` удалена, а [scope-plane](../../packages/scope-plane/src/row-plane.ts), [scope-plane-electric](../../packages/scope-plane-electric/src/index.ts) и [scope-plane-tinybase](../../packages/scope-plane-tinybase/src/index.ts) переведены на `RowPlane` поверх 11 канонических таблиц.
2. **Процессные синглтоны состояния**: `seated` в [blobs/store.ts](../../packages/harness/src/server/blobs/store.ts#L20), `rootDir` в [visual-store.ts](../../packages/harness/src/server/daemon/session/visual-store.ts#L20), а также [secrets.ts](../../packages/harness/src/server/secrets.ts) не привязаны к конкретному `KernelDaemon`.
3. **Завязка `Project` и `policy` на локальную ФС**: [ProjectDaemon.ts](../../packages/harness/src/server/daemon/project/ProjectDaemon.ts#L49-L80) делает `realpathSync` / `statSync().isDirectory()` / `mkdirSync` / `BotsWatcher`; [real-path.ts](../../packages-runtime/turn/src/policy-processor/real-path.ts) и [write-admit.ts](../../packages-runtime/turn/src/tool-runtime/write-admit.ts) вызывают `node:fs` на хосте демона; [state-store.ts](../../packages/harness/src/extensions/state-store.ts#L65-L77) пишет `project`/`global` логи плагинов на диск мимо БД.
4. **Недостающая защита `readOnly` на клиенте** и ручная проекция `@column`-полей `SessionRoot`/`SessionTurn` (отмечено в [аудите](../audits/2026-11-12-architecture-audit.md#L21) и сохраняется в списке работ Волны 2).
