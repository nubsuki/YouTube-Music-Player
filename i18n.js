const path = require("path");
const fs = require("fs");

let translations = {};

// Carga las traducciones
function loadTranslations(locale) {
  try {
    const filePath = path.join(__dirname, "locales", `${locale}.json`);
    if (fs.existsSync(filePath)) {
      translations = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } else {
      // Si el archivo del idioma no existe, usa el inglés como fallback
      console.warn(`Translation file for ${locale} not found. Falling back to 'en'.`);
      translations = JSON.parse(fs.readFileSync(path.join(__dirname, "locales", "en.json"), "utf8"));
    }
  } catch (error) {
    console.error("Error loading translation file:", error);
    // En caso de error, inicializa un objeto vacío para evitar fallos
    translations = {};
  }
}

// Función de traducción
function getTranslator(locale) {
  loadTranslations(locale);
  return (key) => translations[key] || key;
}

module.exports = {
  getTranslator,
};