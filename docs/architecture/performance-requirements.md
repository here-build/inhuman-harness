# Требования к быстродействию (Client & Server SLO)

> Единственный дом для нормативов производительности (`SLO`), методики оценки **Real vs Theoretical Floor** и базовых замеров в `inhuman-harness-public`.  
> См. также: [Карта архитектуры](README.md) · [Единая архитектура](unified-architecture.md) · [Тезаурус](thesaurus.md) · [Запуск бенчмарков](../../benchmarks/README.md) · [JSON-база последнего прогона](../../benchmarks/baselines/latest.json).

---

## 1. Методика: реальное время vs теоретический потолок стека

Для объективной оценки цены абстракций (`Drizzle`, `DocumentContainer`, `MobX`, `UpdateLaneHub`, `LiveShape`, WebSocket framing) каждый сьют в [`benchmarks/`](../../benchmarks/README.md) измеряет **два числа на одной и той же машине, том же процессе `Node.js` и тех же низкоуровневых библиотеках** (`better-sqlite3`, `ws`, V8):

$$
\Omega = \frac{T_{\text{actual}}}{T_{\text{floor}}}, \qquad
\eta = \frac{T_{\text{floor}}}{T_{\text{actual}}} \times 100\%, \qquad
\alpha_{\text{mem}} = \frac{M_{\text{actual}}}{M_{\text{floor}}}
$$

- **`T_floor` / `M_floor` (теоретический потолок стека)** — минимально возможная стоимость той же операции на голом стеке (подготовленные SQL-выражения `better-sqlite3`, прямое чтение/запись по `ws`, `JSON.parse` в плоский `Map`) без слоя моделей, реактивности и маршрутизации подписки.
- **`T_actual` / `M_actual` (реальное время / память)** — полный стек `inhuman` (`DocumentContainer`, `@state` accessors, `MobX computed/autorun`, `HarnessDatabase`, `UpdateLaneHub`, `LiveShape`, `applyNodeShapeDelta`, `Symbol.asyncDispose`).
- **`Ω` (Overhead Multiplier)** — во сколько раз текущий стек дороже голого потолка (`1.0x` = потолок достигнут).
- **`η` (Stack Efficiency)** — доля времени/памяти, уходящая в полезную физическую работу I/O и сериализации, а не в обвязку рантайма.

### Правила достоверности измерений

1. **Изоляция V8 Heap (`--expose-gc`)**: перед каждым замером памяти выполняется двойная принудительная сборка мусора (`forceGc()`) с асинхронной паузой (`setImmediate`), чтобы исключить шум отложенных сборок.
2. **Плоские строки**: тестовые буферы выделяются через UTF-8 декодирование `Buffer.from(...)` (`flatTextOfBytes`), а не через `String.repeat` (`ConsString`), иначе V8 искусственно занижает `heapUsed`.
3. **Детекция утечек**: 20 последовательных циклов создания, гидратации и `Symbol.dispose`-разрушения сессии; наклон линейной регрессии берется по **хвостовым 15 циклам (6–20)**, чтобы отфильтровать прогрев JIT/inline-кэшей первых пяти итераций.

---

## 2. Матрица сьютов (`benchmarks/suites/`)

| Сьют | Что измеряет `Floor` | Что измеряет `Actual` |
| --- | --- | --- |
| [`01-storage-flush`](../../benchmarks/suites/01-storage-flush.bench.mjs) | Сырые `db.prepare(...)` и транзакция `better-sqlite3` (Init 201 узел / 382.25 KB; Delta 1 узел + обновление сессии) | `DocumentContainer.takeNodeDelta()` + `HarnessDatabase.writeTransaction` (`insertSession` / `updateSession` + `commitSessionNodesInTx`) |
| [`02-live-shape-fanout`](../../benchmarks/suites/02-live-shape-fanout.bench.mjs) | `Map.set` + `JSON.stringify`/`JSON.parse` + рассылка по `N` `Map` в памяти (`N = 1, 10, 50`) | `HarnessDatabase.updateSession` → `UpdateLaneHub` → `N` подключенных `LiveShape` через `createLocalShapeTransport` |
| [`03-remote-session-load`](../../benchmarks/suites/03-remote-session-load.bench.mjs) | `ws` + сырой `SELECT` из `session_nodes` + `JSON.parse` в `Map` (профили `S`, `M`, `L`, `M_wan40ms`, `Warm Delta`) | `ws` `shape/delta` + `new DocumentContainer({ readOnly: true })` + `applyNodeShapeDelta` + первый `MobX computed` (`tapeStats`) |
| [`04-client-memory`](../../benchmarks/suites/04-client-memory.bench.mjs) | Retained V8 heap плоского `Map<uuid, plainObject>` после `JSON.parse` (`S`, `M`, `L`) | Retained V8 heap `DocumentContainer` + `MobX computed`/`autorun`, плюс 20 циклов переключения сессий |
| [`05-server-multikernel-density`](../../benchmarks/suites/05-server-multikernel-density.bench.mjs) | Абсолютный бюджет процесса | Монтирование `K=50` изолированных тенантских ядер в одном `HarnessDatabase` + `UpdateLaneHub`, удержание RAM и полная эвикция через `Symbol.asyncDispose` |

---

## 3. Нормативные требования (SLO)

### 3.1 Клиентский контур (`Local Contour` & Remote UI Client)

| Метрика | Профиль / Условие | Целевой SLO | Порог регрессии / Ворота |
| --- | --- | --- | --- |
| **Холодная загрузка удаленной сессии** | `S` (10 turns, 41 узлов, ~87 KB), localhost WS | `p95 <= 5.0 ms`, `Ω <= 3.5x` | `p95 > 10 ms` или `Ω > 5.0x` |
| **Холодная загрузка удаленной сессии** | `M` (100 turns, 401 узел, ~877 KB), localhost WS | `p95 <= 15.0 ms`, `Ω <= 3.5x` | `p95 > 25 ms` или `Ω > 5.0x` |
| **Холодная загрузка удаленной сессии** | `M_wan40ms` (401 узел, эмуляция RTT 40 ms) | `p95 <= 80.0 ms`, `Ω <= 1.3x` | `p95 > 100 ms` (узким горлом обязан оставаться только WAN RTT, а не гидратация) |
| **Холодная загрузка удаленной сессии** | `L` (400 turns, 1601 узел, ~3.5 MB), localhost WS | `p95 <= 60.0 ms`, `Ω <= 3.5x` | `p95 > 90 ms` или `Ω > 5.0x` |
| **Теплая догрузка дельты (Warm Catchup)** | 2 измененных узла (~6.5 KB) поверх открытой `M`-сессии | `p95 <= 3.0 ms`, `Ω <= 6.0x` | `p95 > 5 ms` |
| **Удерживаемая память клиента (`α_mem`)** | `S` / `M` / `L` активный `DocumentContainer` + `MobX` | `α_mem <= 3.5x`, `heap/wire <= 3.5x` | `α_mem > 4.5x`; на одну `M`-сессию `> 4.0 MB`, на `L`-сессию `> 15.0 MB` |
| **Утечка при переключении сессий** | 20 циклов open → hydrate → `autorun` → `Symbol.dispose` | Хвостовой наклон `<= 0.25 MB/cycle` | **Hard Gate (CI fail):** `> 0.50 MB/cycle` |

### 3.2 Серверный контур (`Server Contour` и локальный daemon-storage)

| Метрика | Профиль / Условие | Целевой SLO | Порог регрессии / Архитектурный запас |
| --- | --- | --- | --- |
| **Initial Commit (запись новой сессии)** | 201 узел (~382 KB) за 1 транзакцию | `p95 <= 30.0 ms`, `Ω <= 12.0x` | `p95 > 50 ms` |
| **Incremental Turn Flush (шаг агента)** | Дельта 1 измененного узла + обновление `sessions` | `p95 <= 2.0 ms`, `Ω <= 8.0x` | `p95 > 5 ms` |
| **`LiveShape` Fanout (`N=50` клиентов)** | Рассылка дельты по `recent_sessions` на 50 подключений | `p95 <= 10.0 ms` | `p95 > 20 ms`. *Запас к Волне 5:* коалесцирование и общий кэш `lane + params` в `UpdateLaneHub` (см. разбор ниже) |
| **Плотность ядер (`MultiKernelRegistry`)** | 50 одновременно смонтированных тенантских ядер (без LLM/MCP-подпроцессов) | Mount `<= 25 ms/kernel`; Steady RAM `<= 2.5 MB/kernel` | Steady RAM `> 3.5 MB/kernel` |
| **Выгрузка по `Symbol.asyncDispose`** | Flush хвостов + закрытие подписок + очистка контейнеров (`K=50`) | Evict `<= 25 ms/kernel`; возврат heap `>= 90%` (цель `>= 95%`) | Evict `> 40 ms/kernel` или возврат heap `< 85%` |

---

## 4. Базовые замеры Wave 0.5 (эмпирический эталон)

Зафиксированы прогоном `node --expose-gc benchmarks/run.mjs` из [`baselines/latest.json`](../../benchmarks/baselines/latest.json).

- **Среда**: `Node v22.21.1` (`V8 12.4.254.21-node.33`) · `darwin-arm64` · `Apple M4 Max` (16 cores, 128 GB RAM)
- **Временная метка**: `2026-11-14T21:21:19.907Z`

### 4.1 Storage Flush и LiveShape Fanout

| Сьют и сценарий | `Floor p50` | `Actual p50` | `Actual p95` | `Ω` (`p50`) | `η` (Eff) |
| --- | --- | --- | --- | --- | --- |
| `01` Initial Commit (201 узлов, 382.25 KB) | `1.42 ms` | `12.181 ms` | `18.794 ms` | `8.58x` | `11.66%` |
| `01` Incremental Turn Flush (delta, 100 iters) | `0.05 ms` | `0.258 ms` | `0.349 ms` | `5.16x` | `19.38%` |
| `02` `recent_sessions` (`N=1` peer) | `0.001 ms` | `0.218 ms` | `0.281 ms` | `218x` | `0.46%` |
| `02` `recent_sessions` (`N=10` peers) | `0.002 ms` | `1.087 ms` | `1.356 ms` | `543.5x` | `0.18%` |
| `02` `recent_sessions` (`N=50` peers) | `0.004 ms` | `5.106 ms` | `5.739 ms` | `1276.5x` | `0.08%` |

> [!NOTE]
> **Почему у `LiveShape Fanout` высокий `Ω = 1276.5x` на `N=50` при хорошем абсолютном `p95 = 5.739 ms`:**  
> Во-первых, `Floor` измеряет чистый in-memory `Map` + `JSON`, тогда как `Actual` включает `db.updateSession` (~`0.12 ms` фиксированная база). Во-вторых, время `Actual` линейно масштабируется с ~`0.10 ms` на каждого дополнительного подписчика (`0.218 ms` при `N=1` → `1.087 ms` при `N=10` → `5.106 ms` при `N=50`), поскольку каждый инстанс `LiveShape` отдельно обслуживается в `UpdateLaneHub` вместо общего расчёта запроса на `lane + params`. Для текущего порога `N=50` укладывается в `p95 <= 10 ms`, но при масштабировании >100 одновременных клиентов на серверный узел в Волне 5 требуется общий query-cache в `UpdateLaneHub`.

### 4.2 Удаленная загрузка сессий (Remote Session Load)

| Профиль | Узлы / Трафик | `Floor p50` | `Actual p50` | `Actual p95` | `Ω` (`p50`) | `η` (Eff) |
| --- | --- | --- | --- | --- | --- | --- |
| `S` (10 turns, local) | 41 / 87.2 KB | `0.384 ms` | `0.914 ms` | `1.373 ms` | `2.38x` | `42.01%` |
| `M` (100 turns, local) | 401 / 877.27 KB | `2.551 ms` | `6.544 ms` | `7.274 ms` | `2.57x` | `38.98%` |
| `L` (400 turns, local) | 1601 / 3497.49 KB | `10.317 ms` | `26.88 ms` | `41.531 ms` | `2.61x` | `38.38%` |
| `M_wan40ms` (100 turns, RTT 40ms) | 401 / 883.55 KB | `47.018 ms` | `51.038 ms` | `53.401 ms` | `1.09x` | `92.12%` |
| `M Warm Delta` (patch) | 2 / 6.45 KB | `0.137 ms` | `0.631 ms` | `0.93 ms` | `4.61x` | `21.71%` |

Вывод по удаленной загрузке: стек гидратации `DocumentContainer + applyNodeShapeDelta + MobX computed` добавляет стабильные ~`4 ms` к `M`-сессии поверх голого `JSON.parse`; на реальном WAN с `RTT = 40 ms` доля рантайма составляет менее 8% от общего времени загрузки (`η = 92.12%`, `Ω = 1.09x`).

### 4.3 Расход памяти на клиенте и ворота утечек (Client Memory)

| Профиль | Wire JSON | `Floor` (`Map` heap) | `Actual` (`Container` heap) | `α_mem` (`Actual / Floor`) | `Heap / Wire` |
| --- | --- | --- | --- | --- | --- |
| `S` (41 nodes, avg 10) | `0.085 MB` | `0.089 MB` | `0.267 MB` | `3x` | `3.14x` |
| `M` (401 nodes, avg 3) | `0.856 MB` | `0.91 MB` | `2.672 MB` | `2.94x` | `3.12x` |
| `L` (1601 nodes, avg 2) | `3.412 MB` | `3.604 MB` | `10.255 MB` | `2.85x` | `3.01x` |

- **20-цикловый тест переключения сессий (`M`)**: baseline `34.366 MB`, final `37.835 MB`, хвостовой наклон за 15 циклов = **`0.0065 MB/cycle`** (`netGrowthMb = 0.042 MB`, порог `<= 0.5 MB/cycle`) → **`PASS`**.

### 4.4 Плотность серверных ядер и эвикция (`K = 50` тенантских ядер)

- **Монтирование 50 ядер**: `307.668 ms` суммарно (**`6.153 ms/kernel`**).
- **Удерживаемая память (Steady V8 Heap)**: `21.236 MB` суммарно (**`0.425 MB/kernel`**, дельта RSS процесса `0.516 MB`).
- **Выгрузка через `Symbol.asyncDispose`**: `113.366 ms` суммарно (**`2.267 ms/kernel`**).
- **Освобождение памяти**: возвращено **`97.6%`** heap (`residual = 0.509 MB`).

---

## 5. Регламент верификации в последующих волнах

- **Волна 2** (завершение `@column`-привязок и `readOnly` в `DocumentContainer`): повторный прогон `node --expose-gc benchmarks/run.mjs`; проверить отсутствие роста `Ω` на `03-remote-session-load` и `α_mem <= 3.5x`.
- **Волна 3** (`AsyncDisposableClass` каскад архивации и удаление синглтонов): повторный прогон `04-client-memory` и `05-server-multikernel-density` с подтверждением `reclaimedPct >= 95%` и прохождения leak gate.
- **Волна 5** (переносимый сервер и `MultiKernelRegistry` + `HostRuntimePluginCatalog`): сравнение `Server Contour` с этим baseline, обновление [`baselines/latest.json`](../../benchmarks/baselines/latest.json) и ревизия оптимизации `UpdateLaneHub` для `N=50`.
