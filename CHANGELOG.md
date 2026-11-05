# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-05

### Added
- First version of **Wind Forecast Check**: a Signal K web app comparing the measured WMO 10-minute mean wind, gust and mean direction (from signalk-wmo-gust, through the Signal K History API) with every Open-Meteo model available at the vessel's position.
- Charts for mean wind, gust and direction, with the next 48 hours of forecast; a scorecard of bias and average error per model.
- Verification of the latest runs, or of forecasts issued 1 or 2 days before.
- Each hour is compared with the forecast for where the vessel was; scoring can be limited to moored and at-anchor hours.
- Mean wind and direction are back-filled from raw history from before signalk-wmo-gust was installed.
- Red night mode; Chart.js served from the package so the app works offline on board.

[0.1.0]: https://github.com/PiotrSol/signalk-forecast-verify/releases/tag/v0.1.0
