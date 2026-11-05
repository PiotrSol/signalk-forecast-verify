# signalk-forecast-verify

**Wind Forecast Check**: a Signal K web app that compares the wind your boat actually measured with what the weather models forecast, for the same hours and the same positions, so you learn which model to trust where you sail.

It shows:

- **Mean wind at 10 m**: each model's forecast against the measured WMO 10-minute mean.
- **Gust, highest in the hour**: each model's forecast gust against the highest measured WMO 3-second gust of that hour.
- **Wind direction**: each model's forecast direction against the measured WMO 10-minute mean direction.
- **A scorecard**: per model, the bias (does it run high or low, veer or back?) and the average error, for mean wind, gust and direction, ranked by mean-wind error.
- **The next 48 hours** from every model, after the "now" line.

You can choose to verify the **latest runs**, or the forecasts as they were issued **1 day** or **2 days** before, which is what you'd have used to plan a passage.

A red **night mode** keeps it usable at the chart table on watch.

## Which models

Every model [Open-Meteo](https://open-meteo.com) offers at your position. The app probes each one and leaves out those with no data there:

| Centre | Models |
| :--- | :--- |
| ECMWF | IFS 9 km, AIFS (AI model, no gusts) |
| NOAA | GFS; HRRR and NAM over the United States |
| DWD | ICON, ICON-EU; ICON-D2 over central Europe |
| Météo-France | ARPEGE, AROME, AROME HD over France and its surroundings |
| UK Met Office | Global 10 km |
| KNMI, DMI | HARMONIE-AROME over Europe |
| MET Norway | Nordic, over Scandinavia |
| ECCC, JMA, CMA | GEM, JMA (no gusts), GRAPES |

Off Catalonia, for example, 13 models are available, including AROME HD and HARMONIE.

## How the comparison is made

**Measured wind** comes from **[signalk-wmo-gust](https://github.com/PiotrSol/signalk-wmo-gust)** through the Signal K History API: the WMO 10-minute mean and 3-second gust, ground-referenced and corrected to 10 m. Before that plugin was running, the mean is **back-filled** from raw ground wind in your history, with the same height correction; the chart shows those hours dashed. Gusts are not back-filled, because history recorded every few seconds is too sparse for a 3-second mean.

**Forecasts** are matched hour by hour:

| Forecast (Open-Meteo) | Measured |
| :--- | :--- |
| `wind_speed_10m`, the instantaneous 10 m wind at the hour | The WMO 10-minute mean ending at that hour |
| `wind_gusts_10m`, the highest gust in the preceding hour | The highest WMO gust in that hour |

**Under way**, each hour is compared with the forecast for the position the boat had then, so a passage is verified along its track.

**Scoring** can be limited to hours when the boat was moored or at anchor (highest SOG in the hour below 0.5 kn by default). Those are the cleanest comparisons; under way, the measured ground wind also carries errors from heading, SOG and COG.

## Requirements

- Signal K server 2.x with a **history provider**, for example **signalk-questdb**, recording `navigation.position`, `navigation.speedOverGround` and the wind paths.
- **signalk-wmo-gust** 0.3.0 or later (0.2.0 without direction). Without it, only back-filled mean wind and direction are shown.
- Internet access from the server to Open-Meteo. The app itself, including Chart.js, is served by your Signal K server, so it works on any device on board.

## Installation

From the Signal K App Store, search for **Wind Forecast Check**. Or on the server:

```bash
cd ~/.signalk
npm install signalk-forecast-verify
sudo systemctl restart signalk
```

Enable **Wind Forecast Check** in **Server → Plugin Config**, then open it from **Webapps**. If your server has security enabled, log in first: the app's forecast service runs as a plugin, and Signal K only serves plugin requests to logged-in users.

### Settings

| Setting | Default | Notes |
| :--- | :--- | :--- |
| Stationary below (kn) | 0.5 | Hours with a highest SOG below this count as moored or at anchor |
| Anemometer height (m), for back-filled history | empty | Empty: taken from the signalk-wmo-gust settings, or `design.airHeight` |

The source path, height and profile exponent are read from signalk-wmo-gust's settings, so both apps always use the same correction.

## Notes and limits

- Open-Meteo is free for non-commercial use. The app keeps the load small: model availability is probed once a day per area, and forecasts are cached for 30 minutes on the server.
- Open-Meteo's past data for the latest runs is stitched from the first hours of each run, so "Latest run" verifies 0–24 hour forecasts. Use "1 day before" or "2 days before" to verify planning forecasts. Short-range models such as AROME HD and HARMONIE have no 2-day-ahead runs.
- Some models, such as ECMWF AIFS and JMA, provide no gust forecast. They're scored on mean wind only.
- Forecast data from Open-Meteo.com, licensed CC BY 4.0, from the national weather services that run the models.

## Development

```bash
npm install
npm test          # builds public/ (Chart.js, shared logic), then runs the unit tests
npm run mock      # mock Signal K server with synthetic data on http://localhost:8765
```

## Licence

MIT. See [LICENSE](LICENSE).
