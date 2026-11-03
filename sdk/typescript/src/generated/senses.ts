// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Generated from spec/senses.json. Do not edit; run `pnpm codegen`.

/** How each unit is shown. */
export const UNIT_SYMBOLS: Readonly<Record<string, string>> = {
  "celsius": "°C",
  "percent": "%",
  "watt": "W",
  "kilowatt_hour": "kWh",
  "volt": "V",
  "ampere": "A",
  "lux": "lx",
  "ppm": "ppm",
  "ugm3": "µg/m³",
  "hectopascal": "hPa",
  "decibel": "dB"
};

/**
 * The known sensor senses (ADR 0060): numbers in a unit, on/off states (`on` is what true means)
 * and events. Readings of other senses are accepted too.
 */
export const SENSES = [
  { sense: "temperature", kind: "number", name: "temperature", unit: "celsius" },
  { sense: "humidity", kind: "number", name: "humidity", unit: "percent" },
  { sense: "power", kind: "number", name: "power use", unit: "watt" },
  { sense: "energy", kind: "number", name: "energy used", unit: "kilowatt_hour" },
  { sense: "voltage", kind: "number", name: "voltage", unit: "volt" },
  { sense: "current", kind: "number", name: "current", unit: "ampere" },
  { sense: "illuminance", kind: "number", name: "light level", unit: "lux" },
  { sense: "co2", kind: "number", name: "CO2", unit: "ppm" },
  { sense: "pm25", kind: "number", name: "PM2.5", unit: "ugm3" },
  { sense: "pressure", kind: "number", name: "air pressure", unit: "hectopascal" },
  { sense: "battery", kind: "number", name: "battery", unit: "percent" },
  { sense: "sound_level", kind: "number", name: "sound level", unit: "decibel" },
  { sense: "contact", kind: "state", name: "door or window", on: "open", off: "closed" },
  { sense: "motion", kind: "state", name: "motion", on: "motion", off: "clear" },
  { sense: "occupancy", kind: "state", name: "presence", on: "occupied", off: "clear" },
  { sense: "leak", kind: "state", name: "leak", on: "wet", off: "dry" },
  { sense: "smoke", kind: "state", name: "smoke", on: "smoke", off: "clear" },
  { sense: "carbon_monoxide", kind: "state", name: "carbon monoxide", on: "detected", off: "clear" },
  { sense: "gas", kind: "state", name: "gas", on: "detected", off: "clear" },
  { sense: "switch", kind: "state", name: "switch", on: "on", off: "off" },
  { sense: "lock", kind: "state", name: "lock", on: "unlocked", off: "locked" },
  { sense: "vibration", kind: "state", name: "vibration", on: "vibration", off: "still" },
  { sense: "tamper", kind: "state", name: "tampering", on: "tampered", off: "clear" },
  { sense: "button", kind: "event", name: "button press" },
  { sense: "doorbell", kind: "event", name: "doorbell" },
  { sense: "cover", kind: "state", name: "blind or cover", on: "open", off: "closed" },
  { sense: "alarm", kind: "state", name: "alarm system", on: "armed", off: "disarmed" },
  { sense: "setpoint", kind: "number", name: "thermostat setting", unit: "celsius" },
] as const;
