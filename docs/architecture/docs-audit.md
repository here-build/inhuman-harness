# Аудит документации (`docs-cassowary`)

Дата аудита: 2026-11-15. Проверены корневой `README.md`, все файлы в `docs/`, `docs/architecture-rebuild/`, `docs/proposals/` и `docs/audits/`.

---

## 1. Единственный дом (`Sole-Home Table`)

| Закон / концепция | Канонический документ |
| --- | --- |
| Словарь терминов, контуры `Local`/`Server`, 3-DB изоляция, `inhuman`-плагины, `Project` и `Kill-List` | [thesaurus.md](thesaurus.md) |
| Целевая архитектура клиент+сервер, целевые таблицы БД, `AsyncDisposable`-иерархия, `FS/shell` плагин и DAG волн 0–5 | [unified-architecture.md](unified-architecture.md) |
| Гайд по переносимой серверной инсталляции (`@inhuman.tools/harness/server`, 3-DB изоляция, Caddy + Hono + PostgreSQL) | [../server-installation.md](../server-installation.md) |
| Требования к быстродействию (SLO), методика `T_actual / T_floor` и базовые замеры | [performance-requirements.md](performance-requirements.md) |
| Живая модель цикла `ReAct` / `CodeAct`, бюджетов и восстановления раунда | [../react-round-lifecycle.md](../react-round-lifecycle.md) |
| Изоляция встраиваемого `@inhuman.tools/turn/runtime` и контракт с `kley` | [../proposals/session-runtime-isolation.md](../proposals/session-runtime-isolation.md) |
| Реверс-туннель `inhuman login` через `harness.inhuman.tools` | [../proposals/remote-access.md](../proposals/remote-access.md) |
| Линии тестирования и правила упаковки публичных пакетов | [../testing.md](../testing.md), [../package-guidelines.md](../package-guidelines.md) |

---

## 2. Полная инвентаризация и статус дрейфа

| Документ | Категория | Статус и найденный дрейф | Действие |
| --- | --- | --- | --- |
| [../../README.md](../../README.md) | Публичный вход | Актуализировано в Волне 5: добавлены ссылки на `unified-architecture.md`, `thesaurus.md`, `performance-requirements.md` и `@inhuman.tools/harness/server` | Актуален |
| [../usage.md](../usage.md) | Руководство оператора | Актуально для `Local Contour` (`~/.harness`, `manual`/`auto`/`yolo`). Упоминание «Closing either client ... this is not cloud execution» остается верным для локального режима | Сохранить как операторский гайд CLI |
| [../server-installation.md](../server-installation.md) | Гайд по серверной инсталляции | Обобщённый английский гайд по развёртыванию `@inhuman.tools/harness/server` (3-DB изоляция, `EncryptedSecretsVault`, `HostRuntimePluginCatalog`, Caddy + Hono + PostgreSQL) | Актуален (поддерживать при миграциях потребителей) |
| [../packages.md](../packages.md) | Карта пакетов | Актуализировано в Волнах 1 и 5 (`scope-plane` публичный с каноническим 11-табличным `RowPlane`; добавлены `WorkspaceEnvPort`/`activateProject` в `@inhuman.tools/plugin-sdk` и `@inhuman.tools/harness/server`) | Актуален |
| [../package-guidelines.md](../package-guidelines.md) | Стандарт пакетов | Актуален | Сохранить |
| [../testing.md](../testing.md) | Инженерная спецификация | Актуализировано в Волне 5: добавлена строка запуска бенчмарков `node --expose-gc benchmarks/run.mjs` | Актуален |
| [../react-round-lifecycle.md](../react-round-lifecycle.md) | Спецификация рантайма | Актуализировано в Волне 2 (`DocumentContainer.transact(...)`, committed node deltas, SQLite node checkpoints) | Сохранить |
| [../proposals/remote-access.md](../proposals/remote-access.md) | Пропозал / эксплуатация | В Волне 5 добавлена статусная заметка: описание `Y.Doc`/`Yjs binary` относится к исходному деплою релея 2026-10-30, тогда как ядро и `@inhuman.tools/harness/server` используют `LiveShape` `ShapeDeltaFrame` / `PresenceFrame` | Актуален как заметка о легаси-деплое |
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
2. ~~**Процессные синглтоны состояния**~~ *(закрыто в Волне 3)*: `seated` в [blobs/store.ts](../../packages/harness/src/server/blobs/store.ts) заменен на инстанс-порт `BlobStore` / `MemoryBlobBucket`, `rootDir` в [visual-store.ts](../../packages/harness/src/server/daemon/session/visual-store.ts) переведен на `VisualStorePort` (`FsVisualStore` / `MemoryVisualStore`), [secrets.ts](../../packages/harness/src/server/secrets.ts) — на `SecretsVaultPort`, добавлены `AsyncLocalStorage`-порты (`runWithBlobReader`/`runWithVisualReader`/`runWithBlobWriter`), `WeakMap<SessionRoot, SessionMediaReaders>` и реестр `MultiKernelRegistry`.
3. ~~**Завязка `Project` и `policy` на локальную ФС**~~ *(закрыто в Волне 4)*: добавлен оверлей `Project.pluginConfigs` и `contract.kernel.project.configure`, `FS/shell` вынесены в переключаемый плагин (`toolkit`, `shell`, `@inhuman.tools/plugin-local-env`), а [ProjectDaemon.ts](../../packages/harness/src/server/daemon/project/ProjectDaemon.ts), [real-path.ts](../../packages-runtime/turn/src/policy-processor/real-path.ts) и [write-admit.ts](../../packages-runtime/turn/src/tool-runtime/write-admit.ts) работают через абстракцию `WorkspaceEnvPort` без обращения к локальной ФС.
4. ~~**Недостающая защита `readOnly` на клиенте** и ручная проекция `@column`-полей `SessionRoot`/`SessionTurn`~~ *(закрыто в Волнах 2–3)*: пре-мутационная проверка `ReadOnlyDocumentError` в `@inhuman.tools/model` закрыта в Волне 2; мульти-тенантная проекция `kernelId`/`projectId`, `scm_resources` на серверном контуре и удаление легаси-фоллбэка `'ask'` в [KernelDaemon.ts](../../packages/harness/src/server/daemon/kernel/KernelDaemon.ts) закрыты в Волне 3 (отмечено в [аудите](../audits/2026-11-12-architecture-audit.md#L21)).
