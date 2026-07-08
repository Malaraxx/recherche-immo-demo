/**
 * finance.js — Qualification financière (logique pure, zéro DOM).
 *
 * Les paramètres (taux, HCSF, notaire…) viennent de config-finance.json :
 * chargé par adapter.js dans le navigateur, lu via fs dans les tests Node.
 * `node finance.js` exécute les tests situés en bas de ce fichier.
 *
 * @typedef {Object} FinanceInputs
 * @property {number}  revenus      Revenus nets mensuels du foyer
 * @property {number}  [charges]    Mensualités de crédits en cours
 * @property {number}  [apport]     Apport personnel en euros
 * @property {number}  [duree]      Durée du prêt en années (rabattue sur 15/20/25)
 * @property {string}  [statutPro]  'cdi' | 'fonc' | 'indep' | 'cdd'
 * @property {{adultes:number, enfants:number}} [foyer]
 * @property {number}  [age]        Âge de l'emprunteur (tranche d'assurance)
 * @property {number}  [loyerActuel] Loyer actuel (calcul du saut de charge)
 * @property {boolean} [primo]      Primo-accédant
 * @property {'habitation'|'investissement'} [projet]
 *
 * @typedef {Object} Assessment
 * @property {'confortable'|'plafond'|'atteignable'|'hors_budget'} etat
 * @property {string}  label        Libellé court pour le bandeau de carte
 * @property {number}  mensualite   Mensualité estimée (assurance incluse)
 * @property {number}  tauxEffort   Taux d'effort résultant (0-1)
 * @property {number}  coutTotal    Prix + notaire + garantie
 * @property {string}  raison       Raison financière (1re raison de la carte)
 * @property {?string} conseil      Conseil chiffré ou mention dérogatoire
 * @property {?{quotite:number, texte:string}} ptz
 * @property {?{malus?:boolean, note?:string, alerte?:string, reclassement?:string}} dpe
 */
(function(global){
'use strict';

const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
const fmt = n => Math.round(n).toLocaleString('fr-FR') + ' €';
const WORDNUM = {une:1, un:1, deux:2, trois:3, quatre:4, cinq:5};

/* =========================================================
   Calculs de base
   ========================================================= */
function annuityFactor(tauxAnnuelPct, dureeAns){
  const t = tauxAnnuelPct/100/12, n = dureeAns*12;
  return t/(1 - Math.pow(1+t, -n));
}

function assuranceTaux(cfg, age){
  if(age == null) return cfg.assurance.defaut;
  for(const tr of cfg.assurance.tranches) if(age <= tr.ageMax) return tr.taux;
  return cfg.assurance.defaut;
}

/* =========================================================
   Profil emprunteur
   ========================================================= */
/** @param {FinanceInputs} inp */
function computeProfile(inp, cfg){
  const dSouhaitee = Math.min(inp.duree || 25, cfg.hcsf.dureeMax);
  const duree = [15,20,25].reduce((a,d) => Math.abs(d-dSouhaitee) < Math.abs(a-dSouhaitee) ? d : a);
  const profilTaux = inp.profilTaux === 'top' ? 'top' : 'std';
  const taux = cfg.taux[profilTaux][String(duree)];
  const revenus = inp.revenus || 0, charges = inp.charges || 0, apport = inp.apport || 0;
  const foyer = {adultes:(inp.foyer && inp.foyer.adultes) || 1, enfants:(inp.foyer && inp.foyer.enfants) || 0};
  const assur = assuranceTaux(cfg, inp.age);

  const mensualiteMax = Math.max(0, revenus*cfg.hcsf.tauxEffortMax - charges);
  const facteur = annuityFactor(taux, duree);
  const capaciteEmprunt = mensualiteMax/(facteur + assur/12);
  const budgetTotal = capaciteEmprunt + apport;
  const resteAVivre = revenus - charges - mensualiteMax;
  const seuilRAV = foyer.adultes*cfg.resteAVivre.adulte + foyer.enfants*cfg.resteAVivre.enfant;
  const sautDeCharge = (inp.loyerActuel != null && inp.loyerActuel > 0)
    ? Math.round(mensualiteMax - inp.loyerActuel) : null;

  // Grade A-D : logique du simulateur de financement, enrichie du foyer
  // (reste à vivre sous le seuil) et du saut de charge.
  let pts = 0;
  const ratio = budgetTotal > 0 ? apport/budgetTotal : 0;
  pts += ratio >= 0.20 ? 3 : ratio >= 0.10 ? 2 : ratio > 0 ? 1 : 0;
  pts += ({cdi:3, fonc:3, indep:2, cdd:1})[inp.statutPro || 'cdi'] || 2;
  pts += resteAVivre >= 2000 ? 2 : resteAVivre >= 1200 ? 1 : 0;
  pts += capaciteEmprunt >= 100000 ? 1 : 0;
  if(resteAVivre < seuilRAV) pts -= 1;                        // foyer sous le seuil de reste à vivre
  if(sautDeCharge != null){
    if(sautDeCharge > mensualiteMax*0.5) pts -= 1;            // saut de charge brutal (> +50 %)
    else if(sautDeCharge <= 0) pts += 1;                      // paie déjà plus que la future mensualité
  }
  let grade = pts >= 8 ? 'A' : pts >= 6 ? 'B' : pts >= 4 ? 'C' : 'D';
  if(apport === 0 && (grade === 'A' || grade === 'B')) grade = 'C'; // sans apport, plafond à C

  return {revenus, charges, apport, duree, taux, assur, facteur,
          mensualiteMax, capaciteEmprunt, budgetTotal, resteAVivre, seuilRAV,
          sautDeCharge, grade, foyer,
          primo: !!inp.primo,
          projet: inp.projet === 'investissement' ? 'investissement' : 'habitation'};
}

/* =========================================================
   Évaluation d'UN bien pour un profil
   ========================================================= */
/** @returns {Assessment} */
function assessListing(b, p, cfg){
  const notaire = b.neuf ? cfg.notaire.neuf : (p.primo ? cfg.notaire.ancienPrimo : cfg.notaire.ancien);
  const pret0 = Math.max(0, b.prix*(1+notaire) - p.apport);
  const garantie = pret0*cfg.garantie;
  const coutTotal = b.prix*(1+notaire) + garantie;
  const pret = Math.max(0, coutTotal - p.apport);
  const mensualite = pret*(p.facteur + p.assur/12);
  const tauxEffort = p.revenus > 0 ? (p.charges + mensualite)/p.revenus : 1;
  const effPct = (Math.round(tauxEffort*1000)/10).toLocaleString('fr-FR');

  let etat, label, raison, conseil = null;
  if(tauxEffort <= 0.32){
    etat = 'confortable'; label = 'Confortable';
    raison = 'Mensualité estimée ' + fmt(mensualite) + '/mois — dans votre budget';
  } else if(tauxEffort <= cfg.hcsf.tauxEffortMax){
    etat = 'plafond'; label = 'Au plafond';
    raison = 'Mensualité ' + fmt(mensualite) + '/mois — au plafond de votre capacité (35 %)';
  } else if(tauxEffort <= cfg.hcsf.tauxDerogatoire && p.projet === 'habitation'){
    etat = 'atteignable'; label = 'Atteignable';
    conseil = 'dossier dérogatoire possible (résidence principale' + (p.primo ? ', primo-accédant' : '') + ')';
    raison = 'Effort de ' + effPct + ' % — ' + conseil;
  } else {
    // Apport manquant exact pour ramener l'effort à 35 %
    const gap = pret - p.capaciteEmprunt;
    if(gap > 0 && gap <= 15000){
      const x = Math.ceil(gap/100)*100;
      etat = 'atteignable'; label = 'Atteignable';
      conseil = 'avec +' + fmt(x) + ' d’apport, ce bien passe dans votre budget';
      raison = 'Avec +' + fmt(x) + ' d’apport, ce bien passe dans votre budget';
    } else {
      etat = 'hors_budget'; label = 'Hors budget';
      raison = 'Mensualité ' + fmt(mensualite) + '/mois — au-delà de votre capacité actuelle';
    }
  }

  // PTZ : primo-accédant + logement neuf (informatif, quotité selon le type)
  let ptz = null;
  if(p.primo && b.neuf){
    const q = b.type === 'appartement' ? 50 : 30;
    ptz = {quotite:q, texte:'PTZ possible — jusqu’à ' + q + ' % à taux zéro'};
  }

  // Règles DPE F/G
  let dpe = null;
  if(b.dpe === 'F' || b.dpe === 'G'){
    dpe = {};
    if(p.projet === 'habitation' && (etat === 'plafond' || etat === 'atteignable')){
      dpe.malus = true;
      dpe.note = 'Prévoir un budget travaux (DPE ' + b.dpe + ') — décote négociable';
    }
    if(p.projet === 'investissement'){
      dpe.alerte = b.dpe === 'G' ? 'Location interdite (DPE G)' : 'Location interdite dès 2028 (DPE F)';
    }
    if(b.chauffage === 'electrique' && b.dpeDate && b.dpeDate < 2026){
      dpe.reclassement = 'Reclassement probable (réforme DPE 2026) — bien potentiellement sous-coté';
    }
  }

  return {etat, label, mensualite:Math.round(mensualite), tauxEffort,
          coutTotal:Math.round(coutTotal), pret:Math.round(pret), raison, conseil, ptz, dpe};
}

/* =========================================================
   Parseur financier — mêmes principes que le simulateur de
   financement : montants k€/espaces, mot-clé le plus proche,
   négations. Mutate `fin` et retourne les labels détectés.
   ========================================================= */
function parseFinance(text, fin){
  const t = norm(text);
  const got = [];

  // Montants (les nombres suivis de "ans" sont des durées, pas des montants)
  const amts = [];
  const AMT = /(\d{1,3}(?:\s\d{3})+|\d+(?:[.,]\d+)?)\s*(k€|k\b|€|euros?)?/g;
  let m;
  while((m = AMT.exec(t))){
    let v = parseFloat(m[1].replace(/\s/g,'').replace(',','.'));
    if(m[2] && m[2][0] === 'k') v *= 1000;
    if(/^\s*ans\b/.test(t.slice(m.index + m[0].length))) continue;
    amts.push({v, start:m.index, end:m.index + m[0].length});
  }
  // Montant le plus proche du mot-clé (fenêtre de 35 caractères), borné
  const nearest = (kwRe, min, max) => {
    const mk = t.match(kwRe);
    if(!mk) return null;
    const ks = mk.index, ke = mk.index + mk[0].length;
    let best = null, bd = 36;
    for(const a of amts){
      if(a.v < min || a.v > max) continue;
      const d = a.end <= ks ? ks - a.end : a.start >= ke ? a.start - ke : 0;
      if(d < bd){ bd = d; best = a; }
    }
    return best ? best.v : null;
  };

  const rev = nearest(/gagn\w+|revenus?|salaires?/, 500, 50000);
  if(rev !== null){ fin.revenus = rev; got.push('revenus ' + fmt(rev)); }

  const app = /(?:aucun|sans|pas\s+d\W{0,2})\s*apport/.test(t)
    ? 0 : nearest(/apport|de cote|epargn\w*/, 1000, 900000);
  if(app !== null){ fin.apport = app; got.push('apport ' + fmt(app)); }

  const chg = /(?:aucun|sans|pas de)\s+(?:credit|charge)/.test(t)
    ? 0 : nearest(/credits?|rembours\w+|charges?/, 50, 10000);
  if(chg !== null){ fin.charges = chg; got.push('charges ' + fmt(chg) + '/mois'); }

  const loyer = nearest(/lou(?:e|ons|er)\b|loyer/, 100, 5000);
  if(loyer !== null){ fin.loyerActuel = loyer; got.push('loyer actuel ' + fmt(loyer)); }

  // Foyer
  if(/\ba deux\b|en couple|tous les deux/.test(t)) fin.foyer.adultes = 2;
  const mEnf = t.match(/(\d|un|une|deux|trois|quatre)\s*enfants?/);
  if(mEnf){ fin.foyer.enfants = WORDNUM[mEnf[1]] || +mEnf[1]; got.push(fin.foyer.enfants + ' enfant' + (fin.foyer.enfants>1?'s':'')); }

  // Statut professionnel
  const st = /\bcdi\b/.test(t) ? 'cdi' : /\bcdd\b/.test(t) ? 'cdd'
    : /fonctionnaire/.test(t) ? 'fonc'
    : /independant|freelance|auto.?entrepren\w*/.test(t) ? 'indep' : null;
  if(st){ fin.statutPro = st; got.push(({cdi:'CDI', cdd:'CDD', fonc:'fonctionnaire', indep:'indépendant'})[st]); }

  // Durée ("sur 20 ans") et âge ("j'ai 34 ans")
  const mAge = t.match(/j\W?ai\s+(\d{2})\s*ans/);
  const mDur = t.match(/sur\s+(\d{2})\s*ans/) || (!mAge && t.match(/\b(15|20|25)\s*ans\b/));
  if(mAge){ fin.age = +mAge[1]; got.push(mAge[1] + ' ans'); }
  if(mDur){ fin.duree = +mDur[1]; got.push('sur ' + mDur[1] + ' ans'); }

  // Primo-accession et nature du projet
  if(/primo|premier achat|premiere acquisition/.test(t)){ fin.primo = true; got.push('primo-accédant'); }
  if(/investissement|locatif|pour louer/.test(t)){ fin.projet = 'investissement'; got.push('investissement locatif'); }
  else if(/residence principale|pour y vivre|pour habiter/.test(t)){ fin.projet = 'habitation'; }

  return got;
}

const Finance = {computeProfile, assessListing, parseFinance, annuityFactor, assuranceTaux, fmt};
global.ImmoFinance = Finance;
if(typeof module !== 'undefined' && module.exports) module.exports = Finance;

})(typeof globalThis !== 'undefined' ? globalThis : this);

/* =========================================================
   Tests — `node finance.js`
   (jamais exécutés dans le navigateur)
   ========================================================= */
if(typeof window === 'undefined' && typeof require === 'function' && require.main === module){
  const fs = require('fs'), path = require('path');
  const F = module.exports;
  const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config-finance.json'), 'utf8'));
  let pass = 0, fail = 0;
  const t = (name, ok) => { if(ok){ pass++; console.log('  ok  ' + name); } else { fail++; console.log('  KO  ' + name); } };

  // ---- Profil (réf. : 4 000 €/mois, 0 charges, 30 k€ d'apport, 25 ans, CDI, couple)
  const base = {revenus:4000, charges:0, apport:30000, duree:25, statutPro:'cdi', foyer:{adultes:2, enfants:0}};
  let p = F.computeProfile(base, CFG);
  t('1. capacité ≈ 263 850 € (vérifié à la main), mensualité max 1 400 €',
    Math.abs(p.capaciteEmprunt - 263850) < 300 && p.mensualiteMax === 1400);
  t('2. profil de référence : grade A', p.grade === 'A');
  t('3. apport = 0 → grade plafonné à C', F.computeProfile({...base, apport:0}, CFG).grade === 'C');
  t('4. saut de charge : loyer 800 € → +600 €/mois',
    F.computeProfile({...base, loyerActuel:800}, CFG).sautDeCharge === 600);
  t('5. saut de charge brutal (loyer 400 €, +1 000) → grade B',
    F.computeProfile({...base, loyerActuel:400}, CFG).grade === 'B');
  t('6. loyer actuel ≥ future mensualité (1 500 €) → bonus, grade A',
    F.computeProfile({...base, loyerActuel:1500}, CFG).grade === 'A');
  const rav = {revenus:3000, charges:400, apport:12000, duree:25, statutPro:'cdi'};
  t('7. reste à vivre 1 950 € < seuil foyer 2+1 (2 050 €) → grade C',
    F.computeProfile({...rav, foyer:{adultes:2, enfants:1}}, CFG).grade === 'C');
  t('8. même profil, foyer 2+0 (seuil 1 700 €) → grade B',
    F.computeProfile({...rav, foyer:{adultes:2, enfants:0}}, CFG).grade === 'B');

  // ---- Évaluation d'un bien (états, cas chiffrés vérifiés à la main)
  const ancien = (prix, extra) => Object.assign({prix, type:'maison', dpe:'D'}, extra);
  let a = F.assessListing(ancien(200000), p, CFG);
  t('9. 200 k€ ancien : mensualité ≈ 1 000 €, effort 25 % → confortable',
    a.etat === 'confortable' && Math.abs(a.mensualite - 1000) <= 15);
  a = F.assessListing(ancien(258000), p, CFG);
  t('10. 258 k€ : effort ≈ 33,4 % → plafond', a.etat === 'plafond' && a.tauxEffort > 0.32 && a.tauxEffort <= 0.35);
  a = F.assessListing(ancien(272000), p, CFG);
  t('11. 272 k€ RP : effort ≈ 35,4 % → atteignable (dérogatoire)',
    a.etat === 'atteignable' && /dérogatoire/.test(a.conseil));
  const pInv = F.computeProfile({...base, projet:'investissement'}, CFG);
  a = F.assessListing(ancien(272000), pInv, CFG);
  t('12. 272 k€ investisseur : conseil apport exact "+3 400 €"',
    a.etat === 'atteignable' && /\+3\s400\s€/.test(a.conseil.replace(/ | /g,' ')));
  a = F.assessListing(ancien(400000), p, CFG);
  t('13. 400 k€ : effort 54 % → hors budget (jamais exclu, juste relégué)', a.etat === 'hors_budget');

  // ---- PTZ
  const pPrimo = F.computeProfile({...base, primo:true}, CFG);
  t('14. primo + appartement neuf → PTZ 50 %',
    (F.assessListing({prix:238000, type:'appartement', neuf:true, dpe:'A'}, pPrimo, CFG).ptz || {}).quotite === 50);
  t('15. primo + maison neuve → PTZ 30 %',
    (F.assessListing({prix:238000, type:'maison', neuf:true, dpe:'A'}, pPrimo, CFG).ptz || {}).quotite === 30);
  t('16. primo + ancien → pas de PTZ',
    F.assessListing(ancien(200000), pPrimo, CFG).ptz === null);
  t('17. non-primo + neuf → pas de PTZ',
    F.assessListing({prix:238000, type:'appartement', neuf:true, dpe:'A'}, p, CFG).ptz === null);

  // ---- DPE
  a = F.assessListing(ancien(258000, {dpe:'F'}), p, CFG);
  t('18. habitation au plafond + DPE F → malus et note travaux',
    a.dpe && a.dpe.malus === true && /travaux/.test(a.dpe.note));
  t('19. investisseur + DPE G → location interdite',
    /interdite \(DPE G\)/.test(F.assessListing(ancien(200000, {dpe:'G'}), pInv, CFG).dpe.alerte));
  t('20. investisseur + DPE F → interdite dès 2028',
    /2028/.test(F.assessListing(ancien(200000, {dpe:'F'}), pInv, CFG).dpe.alerte));
  t('21. DPE F + chauffage électrique + DPE de 2024 → reclassement probable',
    /Reclassement/.test(F.assessListing(ancien(200000, {dpe:'F', chauffage:'electrique', dpeDate:2024}), p, CFG).dpe.reclassement || ''));
  t('22. même bien, DPE réalisé en 2026 → pas de badge reclassement',
    !F.assessListing(ancien(200000, {dpe:'F', chauffage:'electrique', dpeDate:2026}), p, CFG).dpe.reclassement);

  // ---- Parseur financier
  const fin = {revenus:0, charges:0, apport:0, duree:25, statutPro:'cdi', foyer:{adultes:1, enfants:0}, age:null, loyerActuel:null, primo:false, projet:'habitation'};
  F.parseFinance('on gagne 5 200 € à deux, 25k d’apport', fin);
  t('23. "on gagne 5 200 € à deux, 25k d\'apport" → revenus, apport, 2 adultes',
    fin.revenus === 5200 && fin.apport === 25000 && fin.foyer.adultes === 2);
  F.parseFinance('je suis en CDI et on loue à 800 €', fin);
  t('24. "je suis en CDI et on loue à 800 €" → statut + loyer',
    fin.statutPro === 'cdi' && fin.loyerActuel === 800);
  F.parseFinance('pas d’apport, primo accédant, sur 20 ans', fin);
  t('25. négation "pas d\'apport" + primo + durée', fin.apport === 0 && fin.primo === true && fin.duree === 20);
  F.parseFinance('avec 2 enfants et 300 € de crédit voiture', fin);
  t('26. enfants + charges', fin.foyer.enfants === 2 && fin.charges === 300);

  console.log('\n' + pass + ' réussis, ' + fail + ' échoués');
  process.exit(fail ? 1 : 0);
}
