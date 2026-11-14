# Architecture Canon

Единая точка входа в живую архитектуру `inhuman` для **Local Contour** (CLI / Desktop) и **Server Contour** (переносимый мульти-тенантный сервер и `../kley`).

## Карта документов (One Law, One Home)

| Документ | Зона ответственности |
| --- | --- |
| [Тезаурус](thesaurus.md) | Канонический словарь терминов, контуры развертывания, двухуровневая модель расширений и список устаревших понятий |
| [Единая архитектура](unified-architecture.md) | Целевая топология клиент+сервер (3-DB изоляция, `AsyncDisposable`, `KernelReflector`, `Project` как оверлей, FS/shell-плагин, DAG волн 0–5) |
| [Требования к быстродействию](performance-requirements.md) | Клиентские и серверные SLO, методика «реальное время vs теоретический потолок стека» (`Ω`, `η`, `α_mem`) и базовые замеры Wave 0.5 |
| [Аудит документации](docs-audit.md) | Инвентаризация всех документов репозитория, фиксация дрейфа (`Yjs`/`Plexus`/схемы) и таблица единственного дома (`sole-home`) |

## Связанные живые спецификации

- [Жизненный цикл раунда ReAct/CodeAct](../react-round-lifecycle.md) — семантика границ раунда и восстановления
- [Изоляция рантайма сессии](../proposals/session-runtime-isolation.md) — контракт встраивания `@inhuman.tools/turn/runtime` и квалификация `kley`
- [Удаленный доступ](../proposals/remote-access.md) — реверс-туннель через relay (`harness.inhuman.tools`)
- [Линии тестирования](../testing.md) и [Карта пакетов](../packages.md)
- [Исторический план пересборки (`architecture-rebuild`)](../architecture-rebuild/00-strategy-and-dag.md) — ненормативный архив перехода с Yjs/Plexus
