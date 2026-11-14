# Harness Performance Benchmarks

Стандартный набор бенчмарков для клиентской и серверной инсталляций `inhuman-harness-public`. Измеряет:

1. **Соотношение реального времени и теоретически достижимого потолка** на той же машине, том же стеке (`Node 22`, `V8`, `better-sqlite3`, `ws`) — **Overhead Multiplier $\Omega = T_{\text{actual}} / T_{\text{floor}}$** и **Эффективность $\eta = T_{\text{floor}} / T_{\text{actual}}$**.
2. **Загрузку удаленных сессий** по WebSocket (холодная гидратация размеров `S`/`M`/`L`, имитация WAN RTT 40 мс и теплые инкрементальные патчи).
3. **Расход памяти на клиентах** (удерживаемый V8 Heap vs `JSON.parse` базы) и тест на утечки памяти при 20 переключениях сессий.
4. **Серверную плотность ядер** (50 одновременных тенантских ядер в RAM и скорость/полнота выгрузки через `Symbol.asyncDispose`).

## Запуск

Перед запуском убедитесь, что собраны `packages/model`, `packages/harness-contract`, `packages/scope-plane`:

```sh
node --expose-gc benchmarks/run.mjs
```

Флаг `--expose-gc` обязателен: без принудительной двойной сборки мусора измерения V8 `heapUsed` содержат шум отложенной сборки. Результаты сохраняются в [`baselines/latest.json`](baselines/latest.json).

Нормативные бюджеты (SLO) и разбор метрик описаны в [требованиях к быстродействию](../docs/architecture/performance-requirements.md).
