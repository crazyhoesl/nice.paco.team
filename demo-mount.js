//Embed the real Helios card in a host element with a synthetic
//`hass` object. Used by the landing page to show the live card.
//No real Home Assistant is involved; the card pulls its own
//basemap (CARTO) and weather (Open-Meteo) over the public CDNs.
//
//Two responsibilities :
//
//  1. Build a mock `hass` object that implements the small subset
//     of HA's frontend API the card actually reads:
//       * states[entity_id]                          for live values
//       * config.{latitude, longitude, ...}          for the home
//       * language                                   page locale
//       * callWS({type: 'history/history_during_period'})
//       * callWS({type: 'recorder/statistics_during_period'})
//       * callWS({type: 'energy/get_prefs'})
//       * callWS({type: 'frontend/get|set_user_data'})
//       * localize, formatEntityState, formatEntityAttributeValue
//       * connection.subscribeEvents / subscribeMessage
//     A 5-second tick refreshes the live PV / battery readings
//     against a clear-sky synthetic curve so the card breathes.
//
//  2. Dynamic-import the Helios bundle from jsdelivr (pinned to
//     the version banner on the site so the demo can never
//     disagree with what users see in HACS), then mount one
//     <helios-card> inside the supplied host element.
//
//Exports a single `mountHeliosDemo({ hostEl, initialLang })` helper
//that returns a handle `{ setLanguage, setTheme }` the host page
//uses to forward language + theme changes from its switchers to
//the embedded card.

//Self-hosted Helios card bundle. Served by nginx alongside the rest of /static/*; refreshed
//automatically by the publish workflow on the Helios card repo on every stable release. Callers can
//override the path via the mountHeliosDemo({ bundleUrl }) parameter.
const HELIOS_BUNDLE_URL = '/static/helios-card-bundle.js';

//Fictional demo home: a residential address in southern France,
//in a dense-enough neighbourhood that the surrounding OpenStreetMap
//buildings give the scene depth and cast real shadows as the sun moves.
const DEMO_HOME        = { latitude: 44.09106147054009, longitude: 1.4507082408018948, elevation: 30 };
const DEMO_PEAK_KWP    = 6.4;

const state = {
    pvPower:        0,
    batterySoc:    55,
    batteryPower:   0,
    //Cumulative kWh counters that mirror the shape a real install would expose
    //via the HA Energy dashboard sources. PV today + battery charge / discharge
    //today + grid import / export since install. The card now resolves chip
    //wiring from `energy/get_prefs` (HA Energy dashboard as single source of
    //truth) so the demo mock returns these entities through the energy_sources
    //payload; the chip then reads live W either directly from the matching
    //power sensor (PV / battery / grid stat_rate) or by differentiating the
    //cumulative meter on the fly.
    pvTodayKwh:           0,
    batteryChargedKwh:    0,
    batteryDischargedKwh: 0,
    gridImportKwh:       15000,
    gridExportKwh:        3000,
    //Signed grid power (positive = importing from the grid, negative =
    //exporting to the grid). Computed each tick as load - PV-net-of-battery so
    //the LIVE grid chip on the Energy-source wired card reads a watt-perfect
    //value without having to differentiate the kWh counters.
    gridPowerW:           0,
};

function clearSkyPvW(date, peakKw)
{
    //Deterministic clear-sky-ish curve (watts, unrounded): a half-period cosine
    //across daylight hours, peak shifted slightly past solar noon. Drives the
    //live PV tick.
    const h        = date.getHours() + date.getMinutes() / 60;
    const x        = (h - 13.4) / 6.5;
    if (Math.abs(x) >= 1) return 0;
    const baseline = Math.cos(x * Math.PI / 2);
    return peakKw * 1000 * Math.max(0, baseline) * baseline;
}

function syntheticPvPower(date, peakKw)
{
    //Live PV power: the clear-sky shape plus a touch of noise so the chip ticks
    //between renders.
    const jitter = 1 + (Math.random() - 0.5) * 0.08;
    return Math.round(clearSkyPvW(date, peakKw) * jitter);
}

function syntheticBattery(date, currentSoc)
{
    //Trapezoid behaviour : charges through the morning, parks at
    //or near full during the sunny window, discharges in the
    //evening. Power sign mirrors the SoC trajectory so the chip
    //arrow direction reads naturally.
    const h = date.getHours() + date.getMinutes() / 60;
    let target;
    if      (h <  6) target = Math.max(10, currentSoc - 0.5);
    else if (h < 12) target = Math.min(95, currentSoc + 1.2);
    else if (h < 17) target = 95;
    else if (h < 22) target = Math.max(40, currentSoc - 1.5);
    else             target = Math.max(25, currentSoc - 0.4);
    const soc     = currentSoc + (target - currentSoc) * 0.08;
    const powerKw = (soc - currentSoc) * 2.5;
    return { soc, powerKw };
}

//Residential household consumption shape: 200 W baseline (fridge,
//standby) + peaks at morning (7-9 h) and evening (18-22 h) when
//cooking + lighting load. Drives the synthetic import / export
//counter ticks below.
function syntheticHomeLoadW(date)
{
    const h = date.getHours() + date.getMinutes() / 60;
    let load = 200;
    if (h >=  7 && h <  9) load += 1200 * Math.sin(((h -  7) / 2) * Math.PI);
    if (h >= 18 && h < 22) load += 1800 * Math.sin(((h - 18) / 4) * Math.PI);
    return load;
}

let _lastSyntheticT = Date.now();

function refreshSyntheticState()
{
    const now = new Date();
    state.pvPower = syntheticPvPower(now, DEMO_PEAK_KWP);
    const { soc, powerKw } = syntheticBattery(now, state.batterySoc);
    state.batterySoc   = soc;
    state.batteryPower = powerKw * 1000;

    //Tick the cumulative counters forward by (delta_t Ã— W). The card uses these
    //meters for the dashboard's cumulative chart + today-kWh headline, derives
    //instantaneous watts from the dE / dt slope where no companion stat_rate
    //power sensor exists, and aggregates them across the configured Energy
    //sources for the multi-source flows the card handles natively.
    const nowMs = now.getTime();
    const dtH   = Math.max(0, (nowMs - _lastSyntheticT) / 3_600_000);
    _lastSyntheticT = nowMs;
    const loadW    = syntheticHomeLoadW(now);
    const battW    = state.batteryPower;         //positive = charging
    //Demo aesthetics: always show BOTH grid chips moving. We import at least
    //the residential load and export at least a small daytime fraction of the
    //PV so the user sees the grid IN / OUT pair ticking like a real
    //bidirectional install would.
    const importBaseW = Math.max(0, loadW - Math.max(0, state.pvPower - battW));
    const exportBaseW = Math.max(0, state.pvPower * 0.25 - 100);
    const importW = importBaseW + 80;
    const exportW = exportBaseW + 30;
    state.gridImportKwh += importW * dtH / 1000;
    state.gridExportKwh += exportW * dtH / 1000;
    //Signed grid power feeds the LIVE grid chip directly via the Energy
    //source's `power_config.stat_rate`. Positive = drawing from the grid,
    //negative = exporting. Computed as net of the two flows so the chip
    //matches the kWh slope to the watt.
    state.gridPowerW = importW - exportW;
    //Integrate PV power into a today-kWh counter that the Energy source's
    //`stat_energy_from` slot reads. Resets back to the start-of-day delta the
    //dashboard cumulative chart picks up from its hourly aggregator.
    state.pvTodayKwh += state.pvPower * dtH / 1000;
    //Battery split: positive battery power = charging (`stat_energy_to`),
    //negative = discharging (`stat_energy_from`). Both monotonic cumulative.
    if (battW > 0) state.batteryChargedKwh    += battW       * dtH / 1000;
    if (battW < 0) state.batteryDischargedKwh += (-battW)    * dtH / 1000;
}

function makeStateObject(entityId, value, unit, deviceClass)
{
    return {
        entity_id: entityId,
        state:     String(Math.round(value * 100) / 100),
        attributes: {
            unit_of_measurement: unit,
            device_class:        deviceClass,
            friendly_name:       entityId,
        },
        last_changed: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        context: { id: 'demo', parent_id: null, user_id: null },
    };
}

function currentStates()
{
    return {
        'sensor.demo_pv_power':              makeStateObject('sensor.demo_pv_power',              state.pvPower,                          'W',   'power'),
        'sensor.demo_pv_today':              makeStateObject('sensor.demo_pv_today',              state.pvTodayKwh.toFixed(3),            'kWh', 'energy'),
        'sensor.demo_battery_soc':           makeStateObject('sensor.demo_battery_soc',           state.batterySoc,                       '%',   'battery'),
        'sensor.demo_battery_power':         makeStateObject('sensor.demo_battery_power',         state.batteryPower,                     'W',   'power'),
        'sensor.demo_battery_charged_kwh':   makeStateObject('sensor.demo_battery_charged_kwh',   state.batteryChargedKwh.toFixed(3),     'kWh', 'energy'),
        'sensor.demo_battery_discharged_kwh':makeStateObject('sensor.demo_battery_discharged_kwh',state.batteryDischargedKwh.toFixed(3),  'kWh', 'energy'),
        'sensor.demo_grid_import':           makeStateObject('sensor.demo_grid_import',           state.gridImportKwh.toFixed(3),         'kWh', 'energy'),
        'sensor.demo_grid_export':           makeStateObject('sensor.demo_grid_export',           state.gridExportKwh.toFixed(3),         'kWh', 'energy'),
        'sensor.demo_grid_power':            makeStateObject('sensor.demo_grid_power',            state.gridPowerW,                       'W',   'power'),
    };
}

//===========================================================================
//Deterministic synthetic curves keyed off a wall-clock timestamp. Unlike
//`refreshSyntheticState()` (which evolves an iterator anchored at "now"),
//these helpers must be evaluable at any past timestamp because the card
//asks for 5-day calibration and 30-day trainer windows that extend well
//before the demo bundle finished loading. They mirror the shape of the
//live-tick functions above so the seam between recorder-backed history,
//statistics, and live updates stays smooth on the rendered chart.
function syntheticSocAt(date)
{
    const h = date.getHours() + date.getMinutes() / 60;
    if      (h <  6) return 25;
    else if (h < 10) return 25 + ((h -  6) / 4) * 70;
    else if (h < 16) return 95;
    else if (h < 22) return 95 - ((h - 16) / 6) * 55;
    else             return Math.max(25, 40 - ((h - 22) / 2) * 15);
}

function syntheticBatteryPowerAt(date)
{
    //Numerical derivative of `syntheticSocAt` scaled by a 5 kWh capacity
    //assumption, returned in watts. Positive = charging.
    const dtH = 0.05;
    const s1  = syntheticSocAt(date);
    const s2  = syntheticSocAt(new Date(date.getTime() + dtH * 3_600_000));
    return Math.round((s2 - s1) / 100 * 5 / dtH * 1000);
}

function syntheticHomeLoadAt(date)
{
    //Same shape as `syntheticHomeLoadW`. Kept separate so the live-tick
    //and stats-replay paths can evolve without nudging each other.
    const h = date.getHours() + date.getMinutes() / 60;
    let load = 200;
    if (h >=  7 && h <  9) load += 1200 * Math.sin(((h -  7) / 2) * Math.PI);
    if (h >= 18 && h < 22) load += 1800 * Math.sin(((h - 18) / 4) * Math.PI);
    return load;
}

//Per-bucket cumulative kWh delta for the synthetic cumulative-energy meters.
//Trapezoid would be more accurate, but the midpoint rule is plenty for hour
//and 5-minute buckets and lets us walk the stats window forward in one cheap
//step per bucket. Returns 0 for any unknown id so a future entity slipping
//through the switch table degrades cleanly instead of throwing.
function cumulativeDeltaKwh(id, startMs, endMs)
{
    const dtH = (endMs - startMs) / 3_600_000;
    const mid = new Date((startMs + endMs) / 2);

    if (id === 'sensor.demo_pv_today')
    {
        const pv = syntheticPvPower(mid, DEMO_PEAK_KWP);
        return pv * dtH / 1000;
    }
    if (id === 'sensor.demo_battery_charged_kwh')
    {
        //Battery is charging when syntheticBatteryPowerAt > 0.
        const battW = syntheticBatteryPowerAt(mid);
        return Math.max(0, battW) * dtH / 1000;
    }
    if (id === 'sensor.demo_battery_discharged_kwh')
    {
        const battW = syntheticBatteryPowerAt(mid);
        return Math.max(0, -battW) * dtH / 1000;
    }

    const load = syntheticHomeLoadAt(mid);
    const pv   = syntheticPvPower(mid, DEMO_PEAK_KWP);
    if (id === 'sensor.demo_grid_import')
    {
        const importW = Math.max(0, load - Math.max(0, pv)) + 80;
        return importW * dtH / 1000;
    }
    if (id === 'sensor.demo_grid_export')
    {
        const exportW = Math.max(0, pv * 0.25 - 100) + 30;
        return exportW * dtH / 1000;
    }
    return 0;
}

//Per-bucket synthetic instantaneous-power value for the W-rated entities.
//Mirrors the shape of the live tick + the syntheticBatteryPowerAt family so
//the recorder-backed past tail of the chart joins the live chip's slope
//smoothly. Returns `null` when the entity is not one of the known live-power
//slots; the caller treats that as "no statistical mean for this bucket".
function meanPowerAt(id, date)
{
    if (id === 'sensor.demo_pv_power')      return syntheticPvPower(date, DEMO_PEAK_KWP);
    if (id === 'sensor.demo_battery_power') return syntheticBatteryPowerAt(date);
    if (id === 'sensor.demo_battery_soc')   return syntheticSocAt(date);
    if (id === 'sensor.demo_grid_power')
    {
        //Recompose the net signed grid power the same way the live tick does,
        //so the stats backfill rejoins the live chip slope cleanly.
        const load = syntheticHomeLoadAt(date);
        const pv   = syntheticPvPower(date, DEMO_PEAK_KWP);
        const importW = Math.max(0, load - Math.max(0, pv)) + 80;
        const exportW = Math.max(0, pv * 0.25 - 100) + 30;
        return importW - exportW;
    }
    return null;
}

//Cumulative kWh counter at past `date`, extrapolated backwards from the
//current live counter by replaying the same baseline-rate model the history
//mock uses. Walks in 15-minute steps so a 30-day backfill is ~2880 iterations
//per call (~ms on a modern browser). Only called ONCE per `mockStatistics`
//invocation to seed the forward bucket walk.
const CUMULATIVE_SENSOR_LIVE = {
    'sensor.demo_pv_today':              () => state.pvTodayKwh,
    'sensor.demo_battery_charged_kwh':   () => state.batteryChargedKwh,
    'sensor.demo_battery_discharged_kwh':() => state.batteryDischargedKwh,
    'sensor.demo_grid_import':           () => state.gridImportKwh,
    'sensor.demo_grid_export':           () => state.gridExportKwh,
};
function isCumulativeEnergySensor(id)
{
    return Object.prototype.hasOwnProperty.call(CUMULATIVE_SENSOR_LIVE, id);
}
function syntheticCumulativeAt(id, date)
{
    const nowMs    = Date.now();
    const targetMs = date.getTime();
    const liveValue = CUMULATIVE_SENSOR_LIVE[id]?.() ?? 0;
    if (targetMs >= nowMs)
    {
        return liveValue;
    }
    let kwh    = liveValue;
    const step = 15 * 60 * 1000;
    for (let t = nowMs; t > targetMs; t -= step)
    {
        const sliceEnd   = t;
        const sliceStart = Math.max(t - step, targetMs);
        kwh -= cumulativeDeltaKwh(id, sliceStart, sliceEnd);
    }
    return Math.max(0, kwh);
}

//Mock `recorder/statistics_during_period`. Returns a per-statistic_id
//array of bucket objects, shape `{ start, end, mean?, state? }`. The
//card's parser prefers `mean` (populated for power-native sensors) and
//falls back to `state` (populated for cumulative-energy sensors). The
//`types` parameter on the request is ignored; we populate the field
//that matches the entity's semantics and the extra one stays absent.
function mockStatistics(msg)
{
    const ids      = Array.isArray(msg?.statistic_ids) ? msg.statistic_ids : [];
    const startMs  = new Date(msg.start_time).getTime();
    const endMs    = new Date(msg.end_time).getTime();
    //The card asks for '5minute' (short windows), 'hour' (month) or 'day' (year);
    //match each so a year-long request returns daily buckets, not 8760 hourly ones.
    const period   = msg.period === '5minute' ? '5minute' : msg.period === 'day' ? 'day' : 'hour';
    const bucketMs = period === '5minute' ? 5 * 60 * 1000
        : period === 'day' ? 24 * 60 * 60 * 1000
        : 60 * 60 * 1000;
    const out      = {};

    for (const id of ids)
    {
        const buckets      = [];
        const isCumulative = isCumulativeEnergySensor(id);
        let counter        = null;
        if (isCumulative)
        {
            counter = syntheticCumulativeAt(id, new Date(startMs));
        }
        for (let t = startMs; t + bucketMs <= endMs; t += bucketMs)
        {
            const bStart = new Date(t);
            const bEnd   = new Date(t + bucketMs);
            const bMid   = new Date(t + bucketMs / 2);
            const bucket = { start: bStart.toISOString(), end: bEnd.toISOString() };

            if (isCumulative)
            {
                const delta = cumulativeDeltaKwh(id, t, t + bucketMs);
                counter += delta;
                bucket.state = Number(counter.toFixed(3));
                //v1.8.4: the card reads the recorder change metric for production / grid /
                //battery, so expose the per-bucket kWh delta alongside the cumulative state.
                bucket.change = Number(delta.toFixed(3));
            }
            else
            {
                const mean = meanPowerAt(id, bMid);
                if (mean !== null) bucket.mean = mean;
            }

            buckets.push(bucket);
        }
        out[id] = buckets;
    }
    return Promise.resolve(out);
}


//Mock WebSocket dispatcher. The card now reaches for three families of
//read endpoints (raw history, long-term statistics, Energy dashboard
//prefs) and one write endpoint (user-data persistence for camera pose
//and lock state). Synthetic data flows through the read paths, the
//writes are accepted as no-ops, everything is wrapped in a resolved
//promise so the await sites just flow.
function mockCallWS(msg)
{
    if (msg && msg.type === 'history/history_during_period')
    {
        const ids     = msg.entity_ids || [];
        const out     = {};
        const startMs = new Date(msg.start_time).getTime();
        const endMs   = new Date(msg.end_time).getTime();
        const stepMs  = 5 * 60 * 1000;
        for (const id of ids)
        {
            const samples = [];
            for (let t = startMs; t < endMs; t += stepMs)
            {
                const d = new Date(t);
                let v = 0;
                if (isCumulativeEnergySensor(id))
                {
                    //Backfill the cumulative-kWh series by replaying the same
                    //baseline rates the live tick uses, integrated BACKWARDS
                    //from the current counter value to the sample timestamp.
                    //The card derives W from the dE/dt slope; matching the
                    //live tick formula means the recorder-history slope and
                    //the first live slope line up cleanly.
                    v = syntheticCumulativeAt(id, d).toFixed(3);
                }
                else
                {
                    const mean = meanPowerAt(id, d);
                    v = mean !== null ? mean : 0;
                }
                samples.push({ s: String(v), lu: Math.floor(t / 1000) });
            }
            out[id] = samples;
        }
        return Promise.resolve(out);
    }
    if (msg && msg.type === 'recorder/statistics_during_period') return mockStatistics(msg);
    //Energy dashboard prefs: returns a hand-crafted `energy_sources` block
    //that mirrors the shape `energy/get_prefs` returns from a real HA install
    //and wires the demo sensors into each slot. Helios resolves PV / grid /
    //battery chip wiring from this payload (the new HA-Energy single-source-
    //of-truth model), so a missing or empty payload would leave every chip
    //blank on the demo card.
    if (msg && msg.type === 'energy/get_prefs')
    {
        const solar = {
            type:             'solar',
            stat_energy_from: 'sensor.demo_pv_today',
            stat_rate:        'sensor.demo_pv_power',
        };
        return Promise.resolve({
        energy_sources: [
            solar,
            {
                type:             'grid',
                //HA Energy schema declares grid import / export as TWO nested
                //arrays (`flow_from` for import, `flow_to` for export), each
                //holding one entry per source. We use the simpler top-level
                //`stat_energy_from` / `stat_energy_to` flat shape Helios
                //parses too, plus a `power_config.stat_rate` for the LIVE
                //signed grid chip. Single source per direction is enough for
                //the demo's split import + export pair.
                stat_energy_from: 'sensor.demo_grid_import',
                stat_energy_to:   'sensor.demo_grid_export',
                power_config:     { stat_rate: 'sensor.demo_grid_power' },
            },
            {
                type:             'battery',
                stat_energy_from: 'sensor.demo_battery_discharged_kwh',
                stat_energy_to:   'sensor.demo_battery_charged_kwh',
                stat_soc:         'sensor.demo_battery_soc',
                power_config:     { stat_rate: 'sensor.demo_battery_power' },
            },
        ],
        });
    }
    //PV forecast, faked as if it came from the HA Energy dashboard's generic
    //solar-forecast surface. The card calls this defensively and merges every
    //returned entry's `wh_hours` (ISO hour -> Wh) into the dashed prediction
    //curve. Cover J-2..J+2 hourly from a clear-sky shape so the Standard window
    //(today + two days ahead) always has a forecast to draw.
    if (msg && msg.type === 'energy/solar_forecast')
    {
        const wh_hours = {};
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const startMs = midnight.getTime() - 2 * 24 * 60 * 60 * 1000;
        for (let i = 0; i < 24 * 5; i++)
        {
            const d = new Date(startMs + i * 60 * 60 * 1000);
            wh_hours[d.toISOString()] = Math.round(clearSkyPvW(d, DEMO_PEAK_KWP));
        }
        return Promise.resolve({ demo_solar_forecast: { wh_hours } });
    }
    if (msg && msg.type === 'frontend/get_user_data') return Promise.resolve({ value: null });
    if (msg && msg.type === 'frontend/set_user_data') return Promise.resolve(null);
    return Promise.resolve(null);
}

function buildMockHass(initialLang)
{
    return {
        states: currentStates(),
        config: {
            latitude:    DEMO_HOME.latitude,
            longitude:   DEMO_HOME.longitude,
            elevation:   DEMO_HOME.elevation,
            time_zone:   Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris',
            unit_system: { length: 'km', mass: 'kg', temperature: 'Â°C', volume: 'L' },
        },
        themes:   { darkMode: false, default_theme: 'default', themes: {} },
        language: initialLang,
        locale:   { language: initialLang, number_format: 'language', time_format: '12', date_format: 'DMY', first_weekday: 'language' },
        localize: (k) => k,
        formatEntityState:           (so) => so?.state ?? '',
        formatEntityAttributeValue:  (_so, attr) => attr,
        callWS:  mockCallWS,
        callApi: () => Promise.resolve(null),
        connection: {
            subscribeEvents:  () => () => {},
            subscribeMessage: () => () => {},
        },
        user: { name: 'Demo', is_admin: false, is_owner: false },
    };
}

//Mount one <helios-card> inside `hostEl`. Returns a small handle
//`{ setLanguage(lang) }` the caller can use to forward locale
//changes from its language switcher to the embedded card. The
//handle's setLanguage is a no-op until the bundle finishes
//loading; calls made earlier are coalesced into the initial mount.
export function mountHeliosDemo({ hostEl, initialLang, initialTheme, initialHome, bundleUrl, cacheId })
{
    const resolvedBundleUrl = (typeof bundleUrl === 'string' && bundleUrl.trim() !== '')
        ? bundleUrl
        : HELIOS_BUNDLE_URL;
    refreshSyntheticState();
    const mockHass = buildMockHass(initialLang || 'en');
    //Optional caller-supplied home override. When present, replaces
    //the DEMO_HOME defaults in mockHass.config so the boot location
    //is whatever the host page wants. The coverage browser uses this
    //to drop the card on the user's clicked point straight away
    //instead of teleporting after the first re-render.
    if (initialHome
        && typeof initialHome.lat === 'number'
        && typeof initialHome.lon === 'number'
        && Number.isFinite(initialHome.lat)
        && Number.isFinite(initialHome.lon))
    {
        mockHass.config.latitude  = initialHome.lat;
        mockHass.config.longitude = initialHome.lon;
    }
    let card = null;
    let pendingLang  = mockHass.language;
    let pendingTheme = (initialTheme === 'light' || initialTheme === 'dark') ? initialTheme : 'dark';
    //PV / grid / battery wiring is resolved from the mocked
    //`energy/get_prefs` payload above; the cfg only carries the install-
    //specific bits HA does not know about (peak kWp + the visual options).
    const cfg = {
        type: 'custom:helios-card',
        //Per-mount cache id: isolates each embedded card's saved view (mode,
        //camera, selected metric) in localStorage. Without it, two cards on the
        //same demo home share one slot and inherit each other's view mode.
        ...(cacheId ? { 'cache-id': cacheId } : {}),
        'auto-rotate-enabled':     false,
        'display-radius':          500,
        'building-count':          100,
        'building-opacity':        0.25,
        'building-cluster-radius': 10,
        'shadow-opacity':          0.4,
    };
    //1.8.0 drives the basemap theme via hass.themes.darkMode instead
    //of the retired `card-theme` YAML key. The initial flag here is
    //picked up on the very first render, and setTheme() below flips
    //it live with a card.hass reassignment.
    function applyThemeFlag(themeName)
    {
        mockHass.themes = { ...(mockHass.themes ?? {}), darkMode: themeName === 'dark' };
        document.body?.classList.toggle('theme-dark', themeName === 'dark');
    }
    //Apply the boot theme RIGHT NOW so the card picks it up on its
    //very first render rather than waiting for the host page to call
    //setTheme(). Without this the card boots in its default light
    //recipe and the user has to toggle the theme switch once to get
    //the dark plate even when the page already declared dark at load.
    applyThemeFlag(pendingTheme);

    const handle = {
        setLanguage(lang)
        {
            if (!lang) return;
            pendingLang = lang;
            mockHass.language = lang;
            mockHass.locale   = { ...mockHass.locale, language: lang };
            if (card) card.hass = { ...mockHass, states: currentStates() };
        },
        setTheme(theme)
        {
            if (theme !== 'light' && theme !== 'dark') return;
            if (theme === pendingTheme) return;
            pendingTheme = theme;
            applyThemeFlag(theme);
            //Re-applying the config triggers a Lit re-render and the
            //card swaps its CSS variable stack + basemap style. The
            //live `hass` reassignment refreshes the readouts in step
            //so chips don't flicker stale on theme flip.
            if (card)
            {
                card.setConfig({ ...cfg });
                card.hass = { ...mockHass, states: currentStates() };
            }
        },
        //Move the embedded card to a new home position. Mutates
        //mockHass.config.{latitude,longitude} and reassigns hass so
        //the card's `updated()` sees a new identity key and re-inits
        //the MapLibre engine against the new coords. Bounds + sanity
        //gates here avoid the engine misfiring on edge cases (NaN
        //from a bad caller, polar extremes Helios is not tuned for).
        setLocation({ lat, lon })
        {
            if (typeof lat !== 'number' || typeof lon !== 'number') return;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            if (lat < -85 || lat > 85) return;
            if (lon < -180 || lon > 180) return;
            //Replace `mockHass.config` with a fresh object so the
            //card's internal getHomeCoords cache, keyed on the
            //hass.config identity, misses and recomputes. Mutating
            //the existing config in place kept the same reference,
            //so the cache returned the previous coords and the
            //engine never re-spawned at the clicked point.
            mockHass.config = { ...mockHass.config, latitude: lat, longitude: lon };
            if (card)
            {
                card.hass = { ...mockHass, states: currentStates() };
            }
        },
    };

    import(resolvedBundleUrl).then(() =>
    {
        card = document.createElement('helios-card');
        //Auto-rotate stays off so the composition is stable; visitors drag
        //to rotate. The card boots in the Standard period by default.
        card.setConfig({ ...cfg });
        card.hass = { ...mockHass, language: pendingLang };
        hostEl.appendChild(card);

        //Tick the synthetic state every 5 s and reassign hass so
        //the card re-renders with the new readings. Pause when the
        //page is hidden so a backgrounded tab doesn't waste CPU.
        setInterval(() =>
        {
            refreshSyntheticState();
            if (!document.hidden && card)
            {
                card.hass = { ...mockHass, states: currentStates() };
            }
        }, 5000);
    }).catch((err) =>
    {
        console.error('[helios] demo bundle load failed:', err);
        hostEl.classList.add('demo-error');
        hostEl.textContent = 'Could not load the Helios card bundle. Try a hard reload, or visit the repository directly: https://github.com/ReikanYsora/Helios';
    });

    return handle;
}
