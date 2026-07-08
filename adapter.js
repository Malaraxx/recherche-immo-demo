/**
 * adapter.js — Source de données des annonces.
 *
 * REMPLACER CE FICHIER pour brancher une autre source (API, flux d'agence,
 * CMS…) : il suffit d'exposer une fonction `loadAnnonces()` qui retourne
 * une Promise résolue avec un tableau d'annonces au format documenté en
 * tête d'engine.js (typedef Annonce).
 */
(function(global){
'use strict';

async function loadAnnonces(){
  const r = await fetch('annonces-test.json');
  if(!r.ok) throw new Error('Chargement des annonces impossible (HTTP ' + r.status + ')');
  return r.json();
}

// Paramètres financiers (taux, HCSF, notaire…) — voir config-finance.json
async function loadConfigFinance(){
  const r = await fetch('config-finance.json');
  if(!r.ok) throw new Error('Chargement de la config financière impossible (HTTP ' + r.status + ')');
  return r.json();
}

global.loadAnnonces = loadAnnonces;
global.loadConfigFinance = loadConfigFinance;

})(typeof globalThis !== 'undefined' ? globalThis : this);
