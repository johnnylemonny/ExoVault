import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rawDir = path.join(rootDir, "data", "raw");
const rawCsvPath = path.join(rawDir, "nasa-exoplanets-ps.csv");
const summaryOutputPath = path.join(rootDir, "src", "generated", "exoplanets-summary.json");
const publicOutputPath = path.join(rootDir, "public", "data", "exoplanets-data.json");
const csvUrl = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name,hostname,default_flag,discoverymethod,disc_year,disc_facility,sy_snum,sy_pnum,pl_orbper,pl_orbsmax,pl_rade,pl_bmasse,pl_eqt,pl_insol,sy_dist,st_teff,st_rad,st_mass,st_spectype,releasedate,rowupdate+from+ps+where+default_flag=1&format=csv";
const DISTANCE_PC_TO_LY = 3.26156;

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInteger(value) {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function safeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactNumber(value, digits = 1) {
  if (value === null || value === undefined) {
    return null;
  }

  return Number(value.toFixed(digits));
}

function slugify(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function classifyRadius(radiusEarth) {
  if (radiusEarth === null) return "unknown";
  if (radiusEarth < 1.25) return "terrestrial";
  if (radiusEarth < 2.5) return "super-earth";
  if (radiusEarth < 4) return "mini-neptune";
  if (radiusEarth < 10) return "neptune-like";
  return "gas-giant";
}

function classifyTemperature(eqTempK) {
  if (eqTempK === null) return "unknown";
  if (eqTempK < 180) return "icy";
  if (eqTempK < 320) return "temperate";
  if (eqTempK < 800) return "warm";
  return "extreme";
}

function normalizePlanet(row) {
  const distanceParsec = toNumber(row.sy_dist);
  const radiusEarth = toNumber(row.pl_rade);
  const massEarth = toNumber(row.pl_bmasse);
  const equilibriumTemp = toNumber(row.pl_eqt);
  const insolation = toNumber(row.pl_insol);
  const discoveryYear = toInteger(row.disc_year);
  const releaseDate = safeText(row.releasedate) || safeText(row.rowupdate);
  const orbitalPeriodDays = toNumber(row.pl_orbper);
  const orbitAu = toNumber(row.pl_orbsmax);

  return {
    slug: slugify(row.pl_name),
    name: safeText(row.pl_name),
    hostName: safeText(row.hostname),
    discoveryMethod: safeText(row.discoverymethod) || "Unknown",
    discoveryYear,
    discoveryFacility: safeText(row.disc_facility) || "Unknown",
    systemStars: toInteger(row.sy_snum) ?? 0,
    systemPlanets: toInteger(row.sy_pnum) ?? 0,
    orbitalPeriodDays: compactNumber(orbitalPeriodDays, orbitalPeriodDays && orbitalPeriodDays > 100 ? 0 : 2),
    orbitAu: compactNumber(orbitAu, 3),
    radiusEarth: compactNumber(radiusEarth, 2),
    massEarth: compactNumber(massEarth, 2),
    equilibriumTempK: compactNumber(equilibriumTemp, 0),
    insolationEarth: compactNumber(insolation, 2),
    distanceLightYears: compactNumber(distanceParsec ? distanceParsec * DISTANCE_PC_TO_LY : null, 2),
    stellarTemperatureK: compactNumber(toNumber(row.st_teff), 0),
    stellarRadiusSolar: compactNumber(toNumber(row.st_rad), 2),
    stellarMassSolar: compactNumber(toNumber(row.st_mass), 2),
    stellarType: safeText(row.st_spectype),
    releaseDate,
    sizeClass: classifyRadius(radiusEarth),
    thermalClass: classifyTemperature(equilibriumTemp),
    isPotentiallyTemperate:
      radiusEarth !== null &&
      equilibriumTemp !== null &&
      insolation !== null &&
      radiusEarth >= 0.7 &&
      radiusEarth <= 1.8 &&
      equilibriumTemp >= 180 &&
      equilibriumTemp <= 320 &&
      insolation >= 0.25 &&
      insolation <= 1.75
  };
}

function uniqueSorted(values, sorter) {
  return [...new Set(values.filter(Boolean))].sort(sorter);
}

function countBy(planets, field) {
  return [...new Set(planets.map((planet) => planet[field]).filter(Boolean))].length;
}

function compareNumeric(field, direction = "asc") {
  return (a, b) => {
    const aValue = a[field] ?? (direction === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    const bValue = b[field] ?? (direction === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);

    if (direction === "asc") return aValue - bValue;
    return bValue - aValue;
  };
}

function getFeaturedWorlds(planets) {
  const picks = [];
  const used = new Set();

  function pushWorld(id, label, eyebrow, description, getCandidate, metric) {
    const candidate = getCandidate(planets.filter((planet) => !used.has(planet.slug)));
    if (!candidate) return;
    used.add(candidate.slug);
    picks.push({ id, label, eyebrow, description, metric, planetSlug: candidate.slug });
  }

  pushWorld("closest", "Closest currently catalogued default world", "Neighborhood pick", "A nearby target that makes the archive feel tangible instead of abstract.", (items) => items.filter((planet) => planet.distanceLightYears !== null).sort(compareNumeric("distanceLightYears", "asc"))[0], (planet) => `${planet.distanceLightYears} ly away`);
  pushWorld("temperate", "Best temperate analogue", "Possible sweet spot", "A world whose size and heat balance land closest to the comfortable middle.", (items) => items.filter((planet) => planet.isPotentiallyTemperate && planet.distanceLightYears !== null).sort(compareNumeric("distanceLightYears", "asc"))[0], (planet) => `${planet.equilibriumTempK} K equilibrium`);
  pushWorld("hottest", "Most extreme heat signature", "Furnace world", "A reminder that many exoplanets are far more violent than anything in our own system.", (items) => items.filter((planet) => planet.equilibriumTempK !== null).sort(compareNumeric("equilibriumTempK", "desc"))[0], (planet) => `${planet.equilibriumTempK} K`);
  pushWorld("giant", "Largest measured giant", "Heavyweight", "A massive discovery that helps visitors anchor the upper edge of planetary scale.", (items) => items.filter((planet) => planet.radiusEarth !== null).sort(compareNumeric("radiusEarth", "desc"))[0], (planet) => `${planet.radiusEarth} Earth radii`);
  pushWorld("busy-system", "Busiest multi-planet system", "Crowded architecture", "A system with a dense planetary lineup, useful for seeing how discovery scales beyond single worlds.", (items) => items.filter((planet) => planet.systemPlanets > 1).sort(compareNumeric("systemPlanets", "desc"))[0], (planet) => `${planet.systemPlanets} known planets`);
  pushWorld("recent", "Most recent catalog favourite", "Fresh archive entry", "A current discovery to signal that the archive is living research, not a frozen dataset.", (items) => items.filter((planet) => planet.discoveryYear !== null).sort((a, b) => { const yearDiff = (b.discoveryYear ?? 0) - (a.discoveryYear ?? 0); if (yearDiff !== 0) return yearDiff; return (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""); })[0], (planet) => `${planet.discoveryYear}`);

  return picks
    .map((feature) => {
      const planet = planets.find((item) => item.slug === feature.planetSlug);
      if (!planet) return null;
      return {
        id: feature.id,
        eyebrow: feature.eyebrow,
        label: feature.label,
        description: feature.description,
        metric: feature.metric(planet),
        planet
      };
    })
    .filter(Boolean);
}

async function main() {
  const csvContent = await fs.readFile(rawCsvPath, "utf8");
  const cleanedCsv = csvContent.split(/\r?\n/).filter(line => line.trim() !== "" && !line.startsWith("#")).join("\n");
  const parsed = Papa.parse(cleanedCsv, { header: true, skipEmptyLines: true });

  if (parsed.errors.length > 0) {
    throw new Error(`CSV parse failed: ${parsed.errors[0]?.message ?? "Unknown error"}`);
  }

  const rows = parsed.data;
  const currentRows = rows.filter((row) => safeText(row.default_flag) === "1" && safeText(row.pl_name));
  const planets = currentRows
    .map(normalizePlanet)
    .sort((a, b) => {
      const yearDiff = (b.discoveryYear ?? 0) - (a.discoveryYear ?? 0);
      if (yearDiff !== 0) return yearDiff;
      return a.name.localeCompare(b.name);
    });

  const years = uniqueSorted(planets.map((planet) => planet.discoveryYear), (a, b) => b - a);
  const methods = uniqueSorted(planets.map((planet) => planet.discoveryMethod), (a, b) => a.localeCompare(b));
  const facilities = uniqueSorted(planets.map((planet) => planet.discoveryFacility), (a, b) => a.localeCompare(b));
  const hostNames = uniqueSorted(planets.map((planet) => planet.hostName), (a, b) => a.localeCompare(b));

  const summary = {
    planetCount: planets.length,
    hostCount: countBy(planets, "hostName"),
    methodCount: methods.length,
    facilityCount: facilities.length,
    minDiscoveryYear: years[years.length - 1] ?? null,
    maxDiscoveryYear: years[0] ?? null
  };

  const fullPayload = {
    generatedAt: new Date().toISOString(),
    source: {
      csvFile: path.relative(rootDir, rawCsvPath).replace(/\\/g, "/"),
      csvUrl,
      archivedRowCount: rows.length,
      defaultRowCount: currentRows.length
    },
    summary,
    filterOptions: { years, methods, facilities, hostNames },
    featuredWorlds: getFeaturedWorlds(planets),
    planets
  };

  const summaryPayload = {
    generatedAt: fullPayload.generatedAt,
    source: fullPayload.source,
    summary,
    featuredWorlds: fullPayload.featuredWorlds
  };

  await fs.mkdir(path.dirname(summaryOutputPath), { recursive: true });
  await fs.mkdir(path.dirname(publicOutputPath), { recursive: true });
  await fs.writeFile(summaryOutputPath, `${JSON.stringify(summaryPayload, null, 2)}\n`, "utf8");
  await fs.writeFile(publicOutputPath, `${JSON.stringify(fullPayload)}\n`, "utf8");

  console.log(`Generated ${fullPayload.planets.length} current planets from ${fullPayload.source.archivedRowCount} archived rows.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
