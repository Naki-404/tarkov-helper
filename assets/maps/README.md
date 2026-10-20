# Векторные карты

Геометрия карт — из открытого проекта [tarkov-dev-svg-maps](https://github.com/the-hideout/tarkov-dev-svg-maps) (авторы — сообщество tarkov.dev), лицензия **CC BY-NC-SA 4.0** (см. `LICENSE-CC-BY-NC-SA-4.0.md`): только некоммерческое использование, производные — под той же лицензией.

Оформление (цвета, обводки, этажи, подсветка зданий) задаётся в приложении — `src/renderer/map-theme.css`. Файлы SVG можно редактировать в любом векторном редакторе (Inkscape и т.п.): уровни — группы верхнего уровня (`Ground_Level`, `First_Floor`, `Second_Floor`, …), классы фигур (`land`, `water`, `building`, `floor`, `locked`, …) определяют стиль.
