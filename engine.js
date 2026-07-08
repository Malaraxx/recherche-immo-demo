/**
 * engine.js — Moteur de recherche immobilier conversationnel (logique pure).
 *
 * Aucune référence au DOM : le même fichier sert le navigateur (global
 * `ImmoEngine`) et Node (`module.exports`). `node engine.js` exécute les
 * tests situés en bas de ce fichier.
 *
 * Format d'annonce standardisé :
 * @typedef {Object} Annonce
 * @property {number}  id       Identifiant unique
 * @property {'maison'|'appartement'} type
 * @property {number}  prix     Prix affiché en euros
 * @property {number}  surf     Surface habitable en m²
 * @property {number}  pieces   Nombre de pièces principales
 * @property {number}  ch       Nombre de chambres
 * @property {number}  jardin   Surface de jardin en m² (0 = pas de jardin)
 * @property {number}  etages   Niveaux au-dessus du rez-de-chaussée (0 = plain-pied)
 * @property {'A'|'B'|'C'|'D'|'E'|'F'|'G'} dpe
 * @property {string}  lieu     Quartier ou commune affiché
 * @property {string}  ville    Commune administrative
 * @property {number}  dist     Distance du centre de Lille en km
 * @property {string}  desc     Description courte
 * @property {string}  atout    Raison de correspondance SPÉCIFIQUE au bien
 * @property {boolean} [viager]  Vente en viager occupé
 * @property {boolean} [travaux] Travaux à prévoir
 * @property {boolean} [neuf]    Programme neuf
 * @property {'electrique'|'gaz'|'fioul'} [chauffage] Mode de chauffage (règles DPE)
 * @property {number}  [dpeDate] Année de réalisation du DPE (réforme 2026)
 */
(function(global){
'use strict';

const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
const fmt = n => Math.round(n).toLocaleString('fr-FR') + ' €';
const WORDNUM = {une:1, un:1, deux:2, trois:3, quatre:4, cinq:5};

// Lieux reconnus par le parseur (formes normalisées sans accents)
const PLACES = [
  {label:'Vieux-Lille',       re:/vieux[\s-]?lille/},
  {label:'Vauban',            re:/vauban/},
  {label:'Wazemmes',          re:/wazemmes/},
  {label:'Fives',             re:/fives/},
  {label:'Saint-Maurice',     re:/saint[\s-]?maurice|st[\s-]?maurice|pellevoisin/},
  {label:'La Madeleine',      re:/madeleine/},
  {label:'Lambersart',        re:/lambersart/},
  {label:'Marcq-en-Barœul',   re:/marcq/},
  {label:"Villeneuve-d'Ascq", re:/villeneuve/},
  {label:'Seclin',            re:/seclin/},
  {label:'Armentières',       re:/armentieres/}
];

/* =========================================================
   État de recherche
   ========================================================= */
function freshCriteria(){
  return {
    budget:null,      // {v, approx} — plafond dur (v×1,1 si approx)
    type:null,        // 'maison' | 'appartement'
    chambres:null,    // minimum (dur)
    pieces:null,      // minimum (dur)
    jardin:null,      // 'soft' (classe) | 'hard' (filtre)
    plainPied:false,  // dur
    lieux:[],         // labels PLACES (dur)
    dist:null,        // {km, hard, min?} — dur si "max", sinon classe
    neuf:null,        // true = neuf uniquement, false = ancien uniquement
    travaux:null,     // false = sans travaux
    famille:false,    // intention détectée → viager exclu
    viagerOnly:false, // l'utilisateur demande explicitement du viager
    allowViager:false // l'utilisateur a retiré la puce d'exclusion
  };
}

/* =========================================================
   Parseur — regex uniquement, aucun appel réseau
   ========================================================= */
// Applique la phrase aux critères `c` (mutation) et retourne les
// critères détectés sous forme de labels courts.
function parseQuery(text, c){
  const t = norm(text);
  const got = [];

  // Budget : "300k", "300 000 €", "max 300k", "autour de 300 000", "monte à 350k"
  const AMT = /(\d{1,3}(?:\s\d{3})+|\d+(?:[.,]\d+)?)\s*(k€|k\b|€|euros?)?/g;
  let m; AMT.lastIndex = 0;
  while((m = AMT.exec(t))){
    let v = parseFloat(m[1].replace(/\s/g,'').replace(',','.'));
    if(m[2] && m[2][0]==='k') v *= 1000;
    if(v < 60000) continue; // trop petit pour être un budget (chambres, minutes, m²…)
    const before = t.slice(Math.max(0, m.index-22), m.index);
    c.budget = {v, approx:/autour|environ|~|dans les/.test(before)};
    got.push('budget ' + (c.budget.approx?'≈ ':'≤ ') + fmt(v));
    break;
  }

  // Type de bien
  if(/maison/.test(t) && !/appart/.test(t)){ c.type='maison'; got.push('maison'); }
  else if(/appart\w*|studio|\bt[1-5]\b|\bf[1-5]\b/.test(t) && !/maison/.test(t)){ c.type='appartement'; got.push('appartement'); }

  // Chambres ("3 chambres", "deux chambres") et pièces ("T3", "4 pièces")
  const mCh = t.match(/(\d+|une?|deux|trois|quatre|cinq)\s*ch(?:ambres?|\b)/);
  if(mCh){ c.chambres = WORDNUM[mCh[1]] || +mCh[1]; got.push('≥ '+c.chambres+' chambre'+(c.chambres>1?'s':'')); }
  const mP = t.match(/\b[tf](\d)\b/) || t.match(/(\d+)\s*pieces?/);
  if(mP){ c.pieces = +mP[1]; got.push('≥ '+c.pieces+' pièces'); }

  // Jardin : souhaité par défaut, exigé si le message insiste
  if(/jardin|exterieur|terrasse/.test(t)){
    c.jardin = /oblig|imperatif|indispensab|absolument|forcement|exige/.test(t) ? 'hard' : (c.jardin==='hard' ? 'hard' : 'soft');
    got.push(c.jardin==='hard' ? 'jardin obligatoire' : 'jardin souhaité');
  } else if(c.jardin==='soft' && /oblig|imperatif|indispensab/.test(t)){
    c.jardin = 'hard'; got.push('jardin obligatoire');
  }

  // Plain-pied
  if(/plain[\s-]?pied|plein[\s-]?pied|sans etage/.test(t)){ c.plainPied = true; got.push('plain-pied'); }

  // Distance : "20 min max de Lille", "15 km", "moins de 10 km", "près de Lille"
  const mMin = t.match(/(\d+)\s*min(?:utes)?/);
  const mKm  = t.match(/(\d+)\s*km/);
  if(mMin){
    const km = Math.round(+mMin[1]*0.75); // ~45 km/h en périurbain
    c.dist = {km, hard:/max|moins de|pas plus/.test(t), min:+mMin[1]};
    got.push((c.dist.hard?'≤ ':'~')+km+' km de Lille');
  } else if(mKm){
    c.dist = {km:+mKm[1], hard:/max|moins de|pas plus/.test(t)};
    got.push((c.dist.hard?'≤ ':'~')+c.dist.km+' km de Lille');
  } else if(/(?:pres|proche|autour)\s+de\s+lille/.test(t)){
    c.dist = {km:8, hard:false}; // préférence douce : classe sans filtrer
    got.push('proche de Lille');
  }

  // Localisation : quartiers et villes de la base
  const replace = /plutot/.test(t);
  const foundPlaces = [];
  let tPlaces = t;
  for(const p of PLACES){
    if(p.re.test(tPlaces)){ foundPlaces.push(p.label); tPlaces = tPlaces.replace(p.re,' '); }
  }
  // "Lille" seule = la ville ; ignorée si contexte de proximité ("près de Lille", "min de Lille")
  if(/\blille\b/.test(tPlaces) && !/(?:pres|proche|autour|min\w*|km|max)\s*(?:de\s+)?lille/.test(tPlaces)){
    foundPlaces.push('Lille');
  }
  if(foundPlaces.length){
    c.lieux = replace ? foundPlaces : [...new Set([...c.lieux, ...foundPlaces])];
    got.push(foundPlaces.join(', '));
  }

  // Neuf / ancien
  if(/\bneuf\b|\bneuve\b/.test(t)){ c.neuf = true; got.push('neuf'); }
  else if(/\bancien(?:ne)?\b/.test(t)){ c.neuf = false; got.push('ancien'); }

  // Travaux
  if(/sans travaux|pas de travaux|cle en main/.test(t)){ c.travaux = false; got.push('sans travaux'); }

  // Viager explicite / intention familiale
  if(/viager/.test(t)){ c.viagerOnly = true; got.push('viager'); }
  if(/famille|enfants?|residence principale/.test(t)){ c.famille = true; }

  return got;
}

/* =========================================================
   Filtrage (critères durs) & scoring (critères souples)
   ========================================================= */
// Règle d'intention anti-viager : recherche familiale → viager EXCLU
function viagerMode(c){
  if(c.viagerOnly) return 'only';
  if(c.allowViager) return null;
  if(c.famille || (c.chambres && c.chambres >= 2)) return 'exclude';
  return null; // toléré mais fortement déclassé par le score
}

function matchLieu(b, lieux){
  return lieux.some(l => b.lieu === l || b.ville === l);
}

/** @param {Annonce[]} annonces */
function filterAnnonces(annonces, c){
  const vg = viagerMode(c);
  return annonces.filter(b=>{
    if(c.budget && b.prix > c.budget.v * (c.budget.approx ? 1.1 : 1)) return false;
    if(c.type && b.type !== c.type) return false;
    if(c.chambres && b.ch < c.chambres) return false;
    if(c.pieces && b.pieces < c.pieces) return false;
    if(c.jardin === 'hard' && !b.jardin) return false;
    if(c.plainPied && b.etages !== 0) return false;
    if(c.lieux.length && !matchLieu(b, c.lieux)) return false;
    if(c.dist && c.dist.hard && b.dist > c.dist.km) return false;
    if(c.neuf === true && !b.neuf) return false;
    if(c.neuf === false && b.neuf) return false;
    if(c.travaux === false && b.travaux) return false;
    if(vg === 'only' && !b.viager) return false;
    if(vg === 'exclude' && b.viager) return false;
    return true;
  });
}

const DPE_PTS = {A:10, B:8, C:5, D:2, E:0, F:-5, G:-9};

// `fin` (optionnel) : Assessment de finance.js — la solvabilité réelle
// devient une règle de pertinence. Hors budget = relégué, JAMAIS exclu
// (afficher la vérité, pas la censure).
function score(b, c, fin){
  let s = 0;
  if(c.jardin === 'soft') s += b.jardin ? 28 : 0;                 // jardin souhaité : classe
  if(c.dist && !c.dist.hard) s += b.dist <= c.dist.km ? 20 : -(b.dist - c.dist.km) * 2;
  if(c.budget){                                                    // bien "à la hauteur" du budget
    const r = b.prix / c.budget.v;
    s += 14 * (1 - Math.min(1, Math.abs(0.85 - r) * 2));
  }
  if(c.chambres) s += Math.min(2, b.ch - c.chambres) * 3;          // chambre bonus
  s += DPE_PTS[b.dpe];
  if(b.travaux && c.travaux === null) s -= 8;
  if(b.viager) s -= 50;                                            // anti-viager : jamais en tête
  if(b.neuf && c.neuf === null) s += 2;
  if(fin){
    if(fin.etat === 'confortable') s += 18;
    else if(fin.etat === 'plafond') s += 4;
    else if(fin.etat === 'atteignable') s -= 6;
    else if(fin.etat === 'hors_budget') s -= 1000;                 // relégué en fin de liste
    if(fin.ptz) s += 8;
    if(fin.dpe && fin.dpe.malus) s -= 6;
  }
  return s;
}

/**
 * @param {Annonce[]} annonces — filtre puis trie par pertinence décroissante
 * @param {?function(Annonce):Object} [assessFn] — b => Assessment (finance.js)
 */
function search(annonces, c, assessFn){
  return filterAnnonces(annonces, c).map(b => ({b, s:score(b, c, assessFn ? assessFn(b) : null)}))
    .sort((x, y) => y.s - x.s || x.b.prix - y.b.prix)
    .map(x => x.b);
}

/* =========================================================
   Raisons de correspondance & suggestions d'assouplissement
   ========================================================= */
// 2-3 raisons max ; si un profil financier existe (`fin`), la raison
// financière vient en PREMIER, puis l'atout spécifique du bien
function buildReasons(b, c, fin){
  const rs = [];
  if(fin && fin.raison) rs.push(fin.raison);
  rs.push(b.atout);
  const cand = [];
  if(c.budget){
    const margin = c.budget.v * (c.budget.approx ? 1.1 : 1) - b.prix;
    if(margin >= 15000) cand.push(fmt(margin) + ' sous votre budget');
  }
  if(c.jardin && b.jardin && !norm(b.atout).includes('jardin')) cand.push('Jardin de ' + b.jardin + ' m²');
  if(c.chambres && b.ch > c.chambres) cand.push(b.ch + ' chambres — une de plus que demandé');
  if((c.dist || c.lieux.length) && !norm(b.atout).includes('lille')) cand.push('À ' + String(b.dist).replace('.',',') + ' km du centre de Lille');
  if((b.dpe === 'A' || b.dpe === 'B') && !b.atout.includes('DPE')) cand.push('DPE ' + b.dpe + ' — énergie maîtrisée');
  return rs.concat(cand.slice(0, 2)).slice(0, 3);
}

// Si < 3 résultats : assouplissements chiffrés RÉELLEMENT calculés sur la base.
// Retourne [{label, mut, gain}] — `mut` applique l'assouplissement aux critères.
function suggestRelaxations(annonces, c, n){
  const out = [];
  const test = (label, mut) => {
    const c2 = JSON.parse(JSON.stringify(c));
    mut(c2);
    const gain = filterAnnonces(annonces, c2).length - n;
    if(gain > 0) out.push({label: label + ' : +' + gain + ' bien' + (gain>1?'s':''), mut, gain});
  };
  if(c.budget)              test('Budget +20 k€',                      x => { x.budget.v += 20000; });
  if(c.dist && c.dist.hard) test('Étendre à ' + (c.dist.km+5) + ' km', x => { x.dist.km += 5; });
  if(c.jardin === 'hard')   test('Jardin souhaité, non exigé',         x => { x.jardin = 'soft'; });
  if(c.plainPied)           test('Accepter un étage',                  x => { x.plainPied = false; });
  if(c.type)                test(c.type==='maison' ? 'Inclure les appartements' : 'Inclure les maisons', x => { x.type = null; });
  if(c.lieux.length)        test('Élargir à toute la métropole',       x => { x.lieux = []; });
  return out.sort((a, b) => b.gain - a.gain).slice(0, 3);
}

const Engine = {freshCriteria, parseQuery, viagerMode, filterAnnonces, score, search, buildReasons, suggestRelaxations, fmt, norm};
global.ImmoEngine = Engine;
if(typeof module !== 'undefined' && module.exports) module.exports = Engine;

})(typeof globalThis !== 'undefined' ? globalThis : this);

/* =========================================================
   Tests — `node engine.js`
   (jamais exécutés dans le navigateur)
   ========================================================= */
if(typeof window === 'undefined' && typeof require === 'function' && require.main === module){
  const fs = require('fs'), path = require('path');
  const E = module.exports;
  const ANN = JSON.parse(fs.readFileSync(path.join(__dirname, 'annonces-test.json'), 'utf8'));
  let pass = 0, fail = 0;
  const t = (name, ok) => { if(ok){ pass++; console.log('  ok  ' + name); } else { fail++; console.log('  KO  ' + name); } };
  const run = msgs => {
    const c = E.freshCriteria();
    let got;
    msgs.forEach(m => { got = E.parseQuery(m, c); });
    return {c, got, res: E.search(ANN, c)};
  };

  // Intégrité des données
  t('1. base de 40 annonces (4 viagers, 3 neufs, 3 travaux)',
    ANN.length===40 && ANN.filter(b=>b.viager).length===4 && ANN.filter(b=>b.neuf).length===3 && ANN.filter(b=>b.travaux).length===3);
  t('2. prix entre 95 000 et 650 000 €',
    Math.min(...ANN.map(b=>b.prix))===95000 && Math.max(...ANN.map(b=>b.prix))===650000);

  // Scénarios validés avant refactor
  let r = run(['Maison 3 chambres avec jardin autour de 300k près de Lille']);
  t('3. intention famille (3 ch) : 9 biens, viagers exclus', r.res.length===9 && !r.res.some(b=>b.viager));
  t('4. "autour de 300k" tolère 315 000 € (plafond ×1,1)', r.res.some(b=>b.prix===315000));

  r = run(['Appartement T2 dans le Vieux-Lille, budget 260 000 €']);
  t('5. Vieux-Lille T2 260k : un seul bien (id 8)', r.res.length===1 && r.res[0].id===8);
  const sg = E.suggestRelaxations(ANN, r.c, r.res.length);
  t('6. relaxation honnête : pas de "+20 k€" mensonger, métropole +13',
    sg.length===1 && /métropole : \+13/.test(sg[0].label));

  r = run(['Maison de plain-pied avec jardin, max 250k']);
  t('7. plain-pied sans intention famille : viager visible mais pas en tête',
    r.res.length===2 && r.res.some(b=>b.viager) && !r.res[0].viager);

  r = run(['maison 3 chambres max 300k', 'en fait plutôt 20 min max de Lille', 'avec jardin obligatoire']);
  t('8. affinage : "20 min max de Lille" → filtre dur ≤ 15 km', r.c.dist && r.c.dist.km===15 && r.c.dist.hard===true);
  t('9. affinage : jardin devenu obligatoire → 5 biens', r.c.jardin==='hard' && r.res.length===5);

  r = run(['maison 4 chambres a Lambersart max 300k', 'monte à 350k']);
  t('10. "monte à 350k" met à jour le budget', r.c.budget.v===350000);

  r = run(['viager sur la métropole']);
  t('11. viager explicite : uniquement les 4 viagers', r.res.length===4 && r.res.every(b=>b.viager));

  r = run(['appartement 1 chambre max 130k']);
  t('12. sans intention famille : viager toléré mais jamais premier',
    r.res.some(b=>b.viager) && !r.res[0].viager);

  // Négations
  r = run(['maison sans travaux max 200k']);
  t('13. "sans travaux" exclut les biens à rénover', r.c.travaux===false && r.res.length>0 && !r.res.some(b=>b.travaux));
  r = run(['appartement clé en main max 150k']);
  t('14. "clé en main" équivaut à sans travaux', r.c.travaux===false && !r.res.some(b=>b.travaux));

  // Alias de lieux
  r = run(['maison à st maurice']);
  t('15. alias "st maurice" → Saint-Maurice', r.c.lieux.includes('Saint-Maurice') && r.res.every(b=>b.lieu==='Saint-Maurice'));
  r = run(['appartement à marcq']);
  t('16. alias "marcq" → Marcq-en-Barœul', r.c.lieux.includes('Marcq-en-Barœul'));
  r = run(['maison vieux lille']);
  t('17. "vieux lille" sans tiret → le quartier, pas Lille entière',
    r.c.lieux.length===1 && r.c.lieux[0]==='Vieux-Lille');
  r = run(['appartement pour notre famille, max 250k']);
  t('18. le mot "famille" seul suffit à exclure le viager', r.c.famille===true && !r.res.some(b=>b.viager));

  console.log('\n' + pass + ' réussis, ' + fail + ' échoués');
  process.exit(fail ? 1 : 0);
}
