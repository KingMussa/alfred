// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ weather.ts — NYC weather via open-meteo (free, no key)               ║
// ║                                                                       ║
// ║ Used in the morning briefing: jobsite-relevant — temp, wind, precip,  ║
// ║ "is it gonna rain on the roof we're capping today" answers.           ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Reno, NV — Dave's home. Confirmed 2026-05-26.
// If he ever moves, change here or add geocoding via preferences.home_zip.
const LAT = 39.5296;
const LON = -119.8138;

export interface WeatherToday {
  tempHigh: number;
  tempLow: number;
  feelsLike: number;
  precipChance: number;   // %
  precipAmount: number;   // mm
  windSpeed: number;      // mph (we convert from m/s)
  conditions: string;     // human label
  sunrise: string;        // ISO
  sunset: string;         // ISO
}

const WMO: Record<number, string> = {
  0: "Clear",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Foggy",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  80: "Rain showers",
  81: "Heavy showers",
  82: "Violent showers",
  95: "Thunderstorm",
  96: "Thunderstorm w/ hail",
  99: "Severe thunderstorm",
};

export async function getTodayWeather(): Promise<WeatherToday> {
  const today = new Date().toISOString().slice(0, 10);

  // Cache layer — same-day data is fine even if cached at 7 AM
  const cacheR = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/rest/v1/weather_cache?cache_date=eq.${today}`,
    {
      headers: {
        Authorization: `Bearer ${KEY}`,
        apikey: KEY,
      },
    },
  );
  const cached = await cacheR.json();
  if (Array.isArray(cached) && cached[0]?.payload) return cached[0].payload as WeatherToday;

  const endpoint =
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,weather_code,wind_speed_10m_max` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=mm&timezone=America%2FLos_Angeles`;

  const r = await fetch(endpoint);
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  const data = await r.json();
  const d = data.daily;
  const c = data.current;

  const out: WeatherToday = {
    tempHigh:     Math.round(d.temperature_2m_max?.[0] ?? c.temperature_2m),
    tempLow:      Math.round(d.temperature_2m_min?.[0] ?? c.temperature_2m),
    feelsLike:    Math.round(c.apparent_temperature ?? c.temperature_2m),
    precipChance: d.precipitation_probability_max?.[0] ?? 0,
    precipAmount: d.precipitation_sum?.[0] ?? 0,
    windSpeed:    Math.round(d.wind_speed_10m_max?.[0] ?? c.wind_speed_10m ?? 0),
    conditions:   WMO[d.weather_code?.[0] ?? c.weather_code] ?? "—",
    sunrise:      d.sunrise?.[0] ?? "",
    sunset:       d.sunset?.[0] ?? "",
  };

  // Cache it
  await fetch(`${URL}/rest/v1/weather_cache`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      apikey: KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ cache_date: today, payload: out }),
  });

  return out;
}

export function formatWeatherLine(w: WeatherToday): string {
  const rain = w.precipChance >= 40 ? ` · ☔️ ${w.precipChance}%` : "";
  const wind = w.windSpeed >= 20 ? ` · 💨 ${w.windSpeed}mph` : "";
  const flag =
    w.precipChance >= 70 ? " 🌧️ Wet day — gear up."
    : w.tempHigh <= 32 ? " 🥶 Bundle up."
    : w.tempHigh >= 90 ? " 🥵 Hot one — hydrate."
    : "";
  return `🌤️ ${w.conditions}, ${w.tempLow}°/${w.tempHigh}°F${rain}${wind}${flag}`;
}
