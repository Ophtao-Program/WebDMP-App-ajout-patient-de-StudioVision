"use strict";
/**
 * main.ts — Processus principal Electron
 * WebDMP Assistant — dépôt automatisé de documents dans Mon Espace Santé
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const recorder_1 = require("./recorder");
const logwriter_1 = require("./logwriter");
const replay_1 = require("./replay");
const doctypes_1 = require("./doctypes");
const PYTHON_SCRIPT = path.join(__dirname, '..', 'python', 'dmp_connector.py');
const INSI_SCRIPT = path.join(__dirname, '..', 'python', 'insi_studiovision.py');
// Mode service : lancé par Se-Connecter-WebDMP.bat (--service). Réside en fond,
// icône près de l'horloge, raccourci global Ctrl+Alt+D pour envoyer le document
// sélectionné dans StudioVision.
const SERVICE_MODE = process.argv.includes('--service');
const HOTKEY = 'CommandOrControl+Alt+D';
let tray = null;
let quickWindow = null;
let savedEcpsId = ''; // identifiant e-CPS mémorisé (config) pour le mode service
let lastConnected = null; // dernier état de connexion connu (null = inconnu)
let mainWindow = null;
let dmpWindow = null;
let dmpAuthenticated = false; // vrai dès qu'une session DMP a été ouverte (évite de relancer OIDC)
// ── État de l'enregistreur d'actions ─────────────────────────────────────────
const LOGS_DIR = path.join(electron_1.app.getPath('userData'), 'dmp_logs');
const LOGS_INDEX = path.join(LOGS_DIR, 'index.jsonl');
let logSession = null; // session d'enregistrement courante
// ── Journaux destinés aux utilisateurs ───────────────────────────────────────
// 1) Journal technique : trace exhaustive de chaque opération (pour l'informaticien).
// 2) Rapport médecin   : uniquement les envois (réussis/échoués) avec patient et date.
const TECH_LOG = path.join(electron_1.app.getPath('userData'), 'journal_technique.txt');
const REPORT_LOG = path.join(electron_1.app.getPath('userData'), 'rapport_medecin.txt');
function nowStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** Écrit une ligne horodatée dans le journal technique (création du fichier au besoin). */
function logTech(message) {
    try {
        if (!fs.existsSync(TECH_LOG)) {
            fs.writeFileSync(TECH_LOG, 'Journal technique — WebDMP Assistant\r\n'
                + 'Trace complete des operations. A transmettre a l\'informaticien en cas de probleme.\r\n'
                + '='.repeat(72) + '\r\n', 'utf-8');
        }
        fs.appendFileSync(TECH_LOG, `[${nowStamp()}] ${message}\r\n`, 'utf-8');
    }
    catch { /* ne jamais bloquer le programme à cause du journal */ }
}
/** Écrit une ligne horodatée dans le rapport médecin (envois uniquement). */
function logReport(line) {
    try {
        if (!fs.existsSync(REPORT_LOG)) {
            fs.writeFileSync(REPORT_LOG, 'Rapport des envois au DMP — WebDMP Assistant\r\n'
                + 'Liste des documents transmis (ou en echec) par patient, avec date.\r\n'
                + '='.repeat(72) + '\r\n', 'utf-8');
        }
        fs.appendFileSync(REPORT_LOG, `[${nowStamp()}] ${line}\r\n`, 'utf-8');
    }
    catch { /* idem */ }
}
/** Injecte le script recorder dans la fenêtre DMP (idempotent). */
function injectRecorder() {
    if (!logSession || !dmpWindow || dmpWindow.isDestroyed())
        return;
    dmpWindow.webContents
        .executeJavaScript((0, recorder_1.buildRecorderScript)(logSession.id))
        .catch(() => { });
}
// ── 1. FENÊTRE PRINCIPALE ────────────────────────────────────────────────────
function createMainWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 480,
        height: 820,
        minWidth: 440,
        minHeight: 600,
        title: 'WebDMP Assistant',
        resizable: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
}
// ── 2. FENÊTRE WEB DMP ───────────────────────────────────────────────────────
function createDmpWindow(visible = true) {
    const win = new electron_1.BrowserWindow({
        width: 1280,
        height: 900,
        title: 'Web DMP — Mon Espace Santé',
        show: visible, // masquée en mode tâche de fond
        webPreferences: {
            preload: path.join(__dirname, 'preload_dmp.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false, // garder la page active même fenêtre masquée
            // Session persistante : garde la connexion CPS/e-CPS entre sessions
            session: require('electron').session.fromPartition('persist:webdmp'),
        },
    });
    win.on('closed', () => {
        dmpWindow = null;
        // Notifier la fenêtre principale que la fenêtre DMP a été fermée
        mainWindow?.webContents.send('dmp-window-closed');
    });
    // Empêcher l'ouverture de pop-ups / liens externes : sans cela, certaines pages
    // (Pro Santé Connect) déclenchent le dialogue Windows « Comment voulez-vous ouvrir
    // ce type d'élément ? ». L'authentification se fait par e-CPS mobile (téléphone),
    // aucune ouverture externe n'est nécessaire ici.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Bloquer les navigations vers un schéma non http(s) (mailto:, protocoles applicatifs…)
    // qui ouvriraient une application tierce.
    win.webContents.on('will-navigate', (event, url) => {
        if (!/^https?:/i.test(url))
            event.preventDefault();
    });
    win.webContents.on('will-redirect', (event, url) => {
        if (!/^https?:/i.test(url))
            event.preventDefault();
    });
    win.webContents.on('did-navigate', (_event, url) => {
        mainWindow?.webContents.send('dmp-url-changed', url);
        if (/\/mespatients/.test(url) || /\/dmp\//.test(url))
            dmpAuthenticated = true;
        if (logSession) {
            logSession.write({ session: logSession.id, seq: 0, t: Date.now(),
                kind: 'navigate', url });
        }
    });
    win.webContents.on('did-navigate-in-page', (_event, url) => {
        mainWindow?.webContents.send('dmp-url-changed', url);
    });
    // À chaque page chargée, si un enregistrement est actif, (ré)injecter le recorder
    win.webContents.on('did-finish-load', () => {
        if (logSession)
            injectRecorder();
    });
    return win;
}
// ── 3. APPEL PYTHON ──────────────────────────────────────────────────────────
function runPythonScript(scriptPath, args) {
    return new Promise((resolve, reject) => {
        const py = (0, child_process_1.spawn)('python', [scriptPath, ...args], {
            env: { ...process.env },
        });
        let stdout = '';
        let stderr = '';
        py.stdout.on('data', (d) => stdout += d.toString());
        py.stderr.on('data', (d) => {
            const line = d.toString();
            stderr += line;
            process.stdout.write('[Python] ' + line);
        });
        py.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Python error (code ${code}):\n${stderr}`));
                return;
            }
            const braceIdx = stdout.indexOf('{');
            const brackIdx = stdout.indexOf('[');
            const jsonStart = (braceIdx === -1) ? brackIdx
                : (brackIdx === -1) ? braceIdx
                    : Math.min(braceIdx, brackIdx);
            if (jsonStart === -1) {
                // Pas de JSON → retourner objet vide sans erreur
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(stdout.slice(jsonStart)));
            }
            catch {
                reject(new Error(`JSON parse error:\n${stdout}`));
            }
        });
    });
}
/** Raccourci : connecteur StudioVision principal (dmp_connector.py). */
function runPython(args) {
    return runPythonScript(PYTHON_SCRIPT, args);
}
// ── 4. IPC ───────────────────────────────────────────────────────────────────
/** Détection du patient actif dans StudioVision */
electron_1.ipcMain.handle('get-active-patient', async () => {
    try {
        const result = await runPython(['--get-active-patient']);
        return { success: true, patient: result };
    }
    catch (err) {
        return { success: false, patient: { code: null }, error: String(err) };
    }
});
/** Infos administratives d'un patient */
electron_1.ipcMain.handle('get-patient-info', async (_event, code) => {
    try {
        const info = await runPython(['--get-info', code]);
        return { success: true, info };
    }
    catch (err) {
        return { success: false, error: String(err) };
    }
});
/** Liste des derniers documents du patient */
electron_1.ipcMain.handle('get-patient-documents', async (_event, code) => {
    try {
        const docs = await runPython(['--get-documents', code]);
        return { success: true, docs };
    }
    catch (err) {
        return { success: false, docs: [], error: String(err) };
    }
});
/** Notes / observations du patient */
electron_1.ipcMain.handle('get-patient-notes', async (_event, code) => {
    try {
        const notes = await runPython(['--get-notes', code]);
        return { success: true, notes };
    }
    catch (err) {
        return { success: false, notes: [], error: String(err) };
    }
});
/** Étape 1 — détecte si le sous-formulaire « CARACTERISTIQUES PATIENT » est ouvert. */
electron_1.ipcMain.handle('insi-detect-form', async () => {
    logTech('INSi : détection du sous-formulaire « CARACTERISTIQUES PATIENT ».');
    try {
        const res = await runPythonScript(INSI_SCRIPT, ['--detect-form']);
        logTech(`INSi : sous-formulaire ${res.present ? 'détecté' : 'non détecté'}.`);
        return res;
    }
    catch (err) {
        logTech(`INSi : échec de la détection (${String(err)}).`);
        return { ok: false, error: String(err) };
    }
});
/** Étape 2 — clique le bouton INSi puis attend le dialogue de validation. */
electron_1.ipcMain.handle('insi-click', async () => {
    logTech('INSi : clic sur le bouton INSi (appel du téléservice).');
    try {
        const res = await runPythonScript(INSI_SCRIPT, ['--click-insi']);
        logTech(`INSi : ${res.ok ? 'dialogue de validation affiché.' : 'échec — ' + (res.error || 'inconnu')}`);
        return res;
    }
    catch (err) {
        logTech(`INSi : échec du clic INSi (${String(err)}).`);
        return { ok: false, error: String(err) };
    }
});
/** Étape 3 — valide (OK) puis lit l'INS dans la fenêtre « Réponse INSi ». */
electron_1.ipcMain.handle('insi-validate', async () => {
    logTech('INSi : validation (OK) et lecture de la réponse.');
    try {
        const res = await runPythonScript(INSI_SCRIPT, ['--validate-read']);
        if (res.ok) {
            // Ne JAMAIS journaliser l'INS lui-même (donnée d'identité de santé).
            const nom = [res.prenoms, res.nom].filter(Boolean).join(' ').trim();
            logTech(`INSi : INS récupéré (15 chiffres)${nom ? ' pour ' + nom : ''}.`);
            logReport(`INS récupéré — ${nom || '(identité non précisée)'}`);
        }
        else {
            logTech(`INSi : lecture échouée — ${res.error || 'inconnu'}.`);
            logReport(`ÉCHEC  — récupération INSi : ${res.error || 'inconnu'}`);
        }
        return res;
    }
    catch (err) {
        logTech(`INSi : exception pendant la validation (${String(err)}).`);
        logReport(`ÉCHEC  — récupération INSi : ${String(err)}`);
        return { ok: false, error: String(err) };
    }
});
/**
 * Ouvre (ou ramène au premier plan) la fenêtre Web DMP.
 * Va directement sur l'URL Pro Santé Connect et pré-remplit l'identifiant e-CPS.
 *
 * URL directe PSC (évite les deux clics "Accès DMP" → "PRO SANTÉ CONNECT") :
 *   https://wallet.esw.esante.gouv.fr/auth/?scope=openid%20scope_all&acr_values=eidas1
 *   &response_type=code&redirect_uri=https://wps-psc.dmp.monespacesante.fr/callbackoidc
 *   &client_id=cnam-webps-dmp
 *
 * Après chargement de la page PSC, on injecte l'identifiant dans le champ login
 * et on focus le bouton "SE CONNECTER AVEC E-CPS" pour que l'utilisateur n'ait
 * plus qu'à appuyer sur Entrée (ou cliquer), puis valider sur son mobile.
 */
const PSC_URL = 'https://wallet.esw.esante.gouv.fr/auth/'
    + '?scope=openid%20scope_all'
    + '&acr_values=eidas1'
    + '&response_type=code'
    + '&redirect_uri=https%3A%2F%2Fwps-psc.dmp.monespacesante.fr%2Fcallbackoidc'
    + '&client_id=cnam-webps-dmp';
// Page d'accueil de l'application DMP. Si la session est déjà active, elle mène
// directement à « Mes Patients » SANS repasser par le tunnel OIDC (ce qui, sur une
// session active, provoque l'erreur "Erreur générale non identifiée" via callbackoidc).
const DMP_HOME = 'https://wps-psc.dmp.monespacesante.fr/';
// Page « Mes patients » (réinitialise le contexte patient). Sert de point d'entrée
// authentifié pour vérifier la session et pour resélectionner le patient.
const MESPATIENTS_URL = 'https://wps-psc.dmp.monespacesante.fr/mespatients/raz';
// Script JS injecté dans la page PSC — remplit l'identifiant et clique automatiquement
function buildLoginScript(ecpsId) {
    const safe = JSON.stringify(ecpsId);
    return `
(function() {
  var MAX_ATTEMPTS = 40;
  var attempt = 0;

  function tryFill() {
    attempt++;
    var selectors = [
      'input[name="login"]', 'input[id="login"]',
      'input[name="username"]', 'input[id="username"]',
      'input[autocomplete="username"]', 'input[type="text"]', 'input[type="email"]',
    ];
    var input = null;
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.offsetParent !== null) { input = el; break; }
    }
    if (!input) {
      if (attempt < MAX_ATTEMPTS) setTimeout(tryFill, 300);
      return;
    }
    // Remplir via le setter natif (compatible React/Angular)
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${safe});
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Cliquer automatiquement sur le bouton e-CPS après un court délai
    setTimeout(function() {
      var btns = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
      var ecpsBtn = btns.find(function(b) {
        var t = (b.textContent || b.getAttribute('value') || '').toLowerCase();
        return t.includes('e-cps') || t.includes('ecps') || t.includes('pro sant');
      });
      if (ecpsBtn) {
        ecpsBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(function() { ecpsBtn.click(); }, 300);
      } else {
        // Fallback : soumettre le formulaire directement
        var form = input.closest('form');
        var submitBtn = form && form.querySelector('button[type="submit"], input[type="submit"]');
        if (submitBtn) { setTimeout(function() { submitBtn.click(); }, 300); }
      }
    }, 700);
  }
  tryFill();
})();
`;
}
/** Attache une seule fois les gestionnaires à la fenêtre DMP (login PSC, recorder, URL). */
function attachDmpHandlers(win, ecpsId) {
    win.webContents.on('did-finish-load', () => {
        const url = win.webContents.getURL();
        const isPscPage = url.includes('wallet.esw.esante.gouv.fr')
            || url.includes('auth.esw.esante.gouv.fr');
        if (isPscPage && ecpsId) {
            win.webContents.executeJavaScript(buildLoginScript(ecpsId)).catch(() => { });
        }
        if (logSession)
            injectRecorder();
        if (mainWindow)
            mainWindow.webContents.send('dmp-url-changed', url);
    });
}
/** Renvoie la fenêtre DMP (la crée masquée/visible si besoin), SANS forcer de navigation. */
function getDmpWindow(background, ecpsId = savedEcpsId) {
    if (!dmpWindow || dmpWindow.isDestroyed()) {
        dmpWindow = createDmpWindow(!background);
        attachDmpHandlers(dmpWindow, ecpsId);
    }
    return dmpWindow;
}
/** Ouvre (ou ramène) la fenêtre DMP et lance l'auth PSC/e-CPS si nécessaire. */
async function ensureDmpWindow(ecpsId, background = false) {
    const fresh = !dmpWindow || dmpWindow.isDestroyed();
    const win = getDmpWindow(background, ecpsId);
    if (fresh) {
        // Session déjà ouverte → page DMP directe (réutilise la session, évite de rejouer
        // OIDC ce qui provoquerait « Erreur générale »). Sinon, tunnel OIDC normal.
        await win.loadURL(dmpAuthenticated ? DMP_HOME : PSC_URL);
    }
    else {
        const currentUrl = win.webContents.getURL();
        const alreadyLoggedIn = currentUrl.includes('dmp.monespacesante.fr')
            || currentUrl.includes('dmp.fr/ps');
        if (!alreadyLoggedIn) {
            await win.loadURL(PSC_URL);
        }
        if (!background)
            win.focus(); // en tâche de fond, rester masquée
    }
    return win;
}
electron_1.ipcMain.handle('open-dmp-window', async (_event, ecpsId) => {
    await ensureDmpWindow(ecpsId);
    return { success: true };
});
/** Ferme la fenêtre DMP */
electron_1.ipcMain.handle('close-dmp-window', () => {
    if (dmpWindow && !dmpWindow.isDestroyed()) {
        dmpWindow.close();
    }
    return { success: true };
});
// ── 4bis. ENREGISTREUR D'ACTIONS WEB DMP ─────────────────────────────────────
/** Réception d'un événement émis par le recorder injecté dans la page DMP. */
electron_1.ipcMain.on('dmp-recorder-event', (_event, ev) => {
    if (!logSession)
        return;
    try {
        logSession.write(ev);
        // Retour live vers la fenêtre principale (compteur + dernière action)
        mainWindow?.webContents.send('recorder-event', {
            seq: ev.seq, kind: ev.kind,
            count: logSession.actionCount,
        });
    }
    catch { /* ignore */ }
});
/**
 * Démarre une session d'enregistrement.
 * patientLabel : ex. "NOM Prenom (code)" — sert d'en-tete de log.
 */
electron_1.ipcMain.handle('recorder-start', (_event, patientLabel) => {
    try {
        if (logSession) {
            // déjà en cours : on clôt proprement la précédente avant d'en ouvrir une neuve
            logSession.close(LOGS_INDEX);
        }
        logSession = new logwriter_1.DmpLogSession(LOGS_DIR, patientLabel || '');
        injectRecorder(); // si la fenêtre DMP est déjà ouverte
        return { success: true, sessionId: logSession.id,
            logFile: logSession.logPath, jsonlFile: logSession.jsonlPath };
    }
    catch (err) {
        return { success: false, error: String(err) };
    }
});
/** Arrête l'enregistrement et renvoie le récapitulatif + chemins de fichiers. */
electron_1.ipcMain.handle('recorder-stop', () => {
    if (!logSession)
        return { success: false, error: 'Aucun enregistrement en cours.' };
    const res = logSession.close(LOGS_INDEX);
    logSession = null;
    return { success: true, ...res };
});
/** Indique si un enregistrement est actif (pour resynchroniser l'UI). */
electron_1.ipcMain.handle('recorder-status', () => {
    return logSession
        ? { recording: true, sessionId: logSession.id, count: logSession.actionCount }
        : { recording: false };
});
/** Ouvre le dossier des journaux dans l'explorateur. */
electron_1.ipcMain.handle('open-logs-folder', () => {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
        electron_1.shell.openPath(LOGS_DIR);
        return { success: true, path: LOGS_DIR };
    }
    catch (err) {
        return { success: false, error: String(err) };
    }
});
/** Liste les sessions enregistrées (lecture de l'index). */
electron_1.ipcMain.handle('list-recordings', () => {
    try {
        if (!fs.existsSync(LOGS_INDEX))
            return { success: true, sessions: [] };
        const lines = fs.readFileSync(LOGS_INDEX, 'utf-8').trim().split('\n').filter(Boolean);
        const sessions = lines.map(l => { try {
            return JSON.parse(l);
        }
        catch {
            return null;
        } })
            .filter(Boolean)
            .reverse(); // plus récentes d'abord
        return { success: true, sessions };
    }
    catch (err) {
        return { success: false, sessions: [], error: String(err) };
    }
});
// ── 4ter. DÉPÔT AUTOMATIQUE SUR LE DMP (moteur de rejeu) ─────────────────────
let depositRunning = false;
/**
 * Lance le dépôt automatique d'un document.
 * Ouvre la fenêtre DMP (auth e-CPS), attend la validation mobile, puis automatise
 * toute la suite. La progression est renvoyée au renderer via 'deposit-progress'.
 */
electron_1.ipcMain.handle('dmp-deposit', async (_event, opts) => {
    if (depositRunning)
        return { ok: false, error: 'Un dépôt est déjà en cours.' };
    // Contrôle préalable avant même d'ouvrir le DMP
    const pf = (0, replay_1.preflight)(opts);
    if (!pf.ok)
        return { ok: false, error: pf.reason };
    depositRunning = true;
    const emit = (info) => mainWindow?.webContents.send('deposit-progress', info);
    try {
        const win = await ensureDmpWindow(opts.ecpsId || '', !!opts.background);
        const res = await (0, replay_1.runDeposit)(win, opts, emit);
        return res;
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
    finally {
        depositRunning = false;
    }
});
/** Lit la liste des types de documents proposés par le portail (si page d'ajout ouverte). */
electron_1.ipcMain.handle('dmp-read-doctypes', async () => {
    if (!dmpWindow || dmpWindow.isDestroyed())
        return { success: false, types: [], error: 'Fenêtre DMP non ouverte.' };
    const types = await (0, replay_1.readDocTypes)(dmpWindow);
    return { success: true, types };
});
/**
 * Copie le texte d'une note dans le presse-papier
 */
electron_1.ipcMain.handle('copy-to-clipboard', (_event, text) => {
    electron_1.clipboard.writeText(text);
    return { success: true };
});
/**
 * Ouvre un document (PDF/image) dans l'application par défaut du système
 */
electron_1.ipcMain.handle('open-document', (_event, cheminPhysique) => {
    electron_1.shell.openPath(cheminPhysique);
    return { success: true };
});
/**
 * Ouvre le guide utilisateur
 */
electron_1.ipcMain.handle('ouvrir-guide', () => {
    const guidePath = path.join(__dirname, '..', 'src', 'renderer', 'guide_dmp.html');
    if (fs.existsSync(guidePath)) {
        electron_1.shell.openPath(guidePath);
    }
    return { success: true };
});
/**
 * Sauvegarde la configuration (identifiant e-CPS, etc.)
 */
const CONFIG_PATH = path.join(electron_1.app.getPath('userData'), 'webdmp_config.json');
electron_1.ipcMain.handle('save-config', (_event, config) => {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
        return { success: true };
    }
    catch (err) {
        return { success: false, error: String(err) };
    }
});
electron_1.ipcMain.handle('load-config', () => {
    try {
        if (!fs.existsSync(CONFIG_PATH))
            return { success: true, config: {} };
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return { success: true, config: JSON.parse(raw) };
    }
    catch (err) {
        return { success: false, config: {}, error: String(err) };
    }
});
// ── 4quater. MODE SERVICE (Ctrl+Alt+D depuis StudioVision) ───────────────────
/** Notification système discrète (icône près de l'horloge). */
function notify(title, body) {
    try {
        const { Notification } = require('electron');
        if (Notification.isSupported())
            new Notification({ title, body }).show();
    }
    catch { /* ignore */ }
}
/** Icône de la zone de notification : fichier PNG fourni, sinon point bleu en dur. */
function makeTrayIcon() {
    try {
        const p = path.join(__dirname, '..', 'assets', 'tray.png');
        if (fs.existsSync(p)) {
            const img = electron_1.nativeImage.createFromPath(p);
            if (!img.isEmpty())
                return img;
        }
    }
    catch { /* ignore */ }
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAfElEQVR4nGNgGAWjYBSMglEwCkbB' +
        'KBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNg' +
        'FIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIwCAEhfA9n7l0gAAAAAAElF' +
        'TkSuQmCC';
    return electron_1.nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
}
/** Met à jour l'info-bulle de l'icône selon l'état de connexion connu. */
function updateTrayStatus(connected) {
    lastConnected = connected;
    if (!tray)
        return;
    const base = 'WebDMP Assistant';
    const etat = connected === true ? 'connecté'
        : connected === false ? 'non connecté'
            : 'état inconnu';
    tray.setToolTip(`${base} — ${etat} (clic gauche : vérifier · Ctrl+Alt+D : envoyer)`);
}
/**
 * Vérifie RÉELLEMENT si la session DMP est encore active, en chargeant la liste
 * patients (page authentifiée) dans la fenêtre masquée : si on y reste, on est
 * connecté ; si on est redirigé vers Pro Santé Connect, la session a expiré.
 * Lecture seule (ne montre pas la fenêtre, ne déclenche pas d'authentification).
 */
async function checkConnectionStatus() {
    const win = getDmpWindow(true); // masquée
    try {
        await win.loadURL(MESPATIENTS_URL);
    }
    catch { /* navigation interrompue */ }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        let u = '';
        try {
            u = win.webContents.getURL();
        }
        catch { }
        if (/wallet\.esw\.esante\.gouv\.fr/.test(u) || /auth\.esw\.esante\.gouv\.fr/.test(u))
            return false;
        if (/\/mespatients/.test(u) || /\/dmp\//.test(u))
            return true; // resté sur le DMP = authentifié
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}
/** Clic gauche sur l'icône : indique si la session est encore active. */
async function showConnectionStatus() {
    if (depositRunning || (quickWindow && !quickWindow.isDestroyed())) {
        notify('WebDMP Assistant', 'Opération en cours… réessayez juste après.');
        return;
    }
    logTech('Vérification du statut de connexion (clic icône).');
    notify('WebDMP Assistant', 'Vérification de la connexion…');
    const ok = await checkConnectionStatus();
    updateTrayStatus(ok);
    if (ok) {
        notify('WebDMP Assistant', '✓ Session e-CPS active. Vous pouvez envoyer (Ctrl+Alt+D).');
        logTech('Statut : session active.');
    }
    else {
        notify('WebDMP Assistant', '✗ Non connecté. Menu de l\'icône → « Se connecter / vérifier la connexion ».');
        logTech('Statut : non connecté.');
    }
}
/**
 * Établit (ou rétablit) la connexion e-CPS de façon fiable : on force le chargement
 * de la liste patients ; si la session est valide, c'est terminé ; sinon on affiche
 * la fenêtre PSC pour la validation e-CPS, puis on la masque une fois connecté.
 */
async function connectOrVerify() {
    if (depositRunning) {
        notify('WebDMP Assistant', 'Un dépôt est en cours, réessayez juste après.');
        return;
    }
    logTech('Connexion e-CPS : établissement/vérification demandé.');
    const win = getDmpWindow(false); // créée si besoin (gestionnaires attachés)
    win.hide(); // test discret d'abord
    try {
        await win.loadURL(MESPATIENTS_URL);
    }
    catch { }
    let settled = false;
    const onNav = () => {
        if (settled)
            return;
        let u = '';
        try {
            u = win.webContents.getURL();
        }
        catch {
            return;
        }
        if (/\/mespatients/.test(u) || /\/dmp\//.test(u)) {
            settled = true;
            win.webContents.removeListener('did-navigate', onNav);
            win.hide();
            updateTrayStatus(true);
            notify('WebDMP Assistant', '✓ Connexion e-CPS active.');
            logTech('Connexion e-CPS : active.');
        }
        else if (/wallet\.esw\.esante\.gouv\.fr/.test(u) || /auth\.esw\.esante\.gouv\.fr/.test(u)) {
            // Authentification nécessaire : on montre la fenêtre pour la validation e-CPS.
            win.show();
            win.focus();
            logTech('Connexion e-CPS : page PSC affichée pour validation.');
        }
    };
    win.webContents.on('did-navigate', onNav);
    setTimeout(onNav, 1000); // si on est déjà authentifié, déclencher la vérification
    // Délai max (validation mobile ≤120 s)
    setTimeout(() => {
        if (settled)
            return;
        settled = true;
        try {
            win.webContents.removeListener('did-navigate', onNav);
        }
        catch { }
        let u = '';
        try {
            u = win.webContents.getURL();
        }
        catch { }
        const ok = /\/mespatients/.test(u) || /\/dmp\//.test(u);
        updateTrayStatus(ok);
        if (ok) {
            win.hide();
            notify('WebDMP Assistant', '✓ Connexion e-CPS active.');
        }
        else {
            win.show();
            win.focus();
            notify('WebDMP Assistant', 'Validez l\'authentification e-CPS dans la fenêtre affichée.');
        }
        logTech(`Connexion e-CPS : ${ok ? 'active' : 'non établie (délai)'}.`);
    }, 130000);
}
function setupTray() {
    if (tray)
        return;
    tray = new electron_1.Tray(makeTrayIcon());
    updateTrayStatus(null);
    const menu = electron_1.Menu.buildFromTemplate([
        { label: 'WebDMP Assistant', enabled: false },
        { type: 'separator' },
        { label: 'Envoyer le document sélectionné (Ctrl+Alt+D)', click: () => triggerQuickDeposit() },
        { label: 'Se connecter / vérifier la connexion e-CPS', click: () => connectOrVerify() },
        { label: 'Vérifier le statut de connexion', click: () => showConnectionStatus() },
        { type: 'separator' },
        { label: 'Ouvrir le log technique', click: () => { logTech('Ouverture du log technique.'); electron_1.shell.openPath(TECH_LOG); } },
        { label: 'Ouvrir le rapport médecin', click: () => { if (!fs.existsSync(REPORT_LOG))
                logReport('(aucun envoi pour le moment)'); electron_1.shell.openPath(REPORT_LOG); } },
        { type: 'separator' },
        { label: 'Quitter', click: () => { electron_1.app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    // Clic gauche sur l'icône : vérifier si la session est encore active.
    tray.on('click', () => { showConnectionStatus(); });
}
/** Résout le chemin physique d'un document à partir de son [Photo externe] relatif. */
function resolveDocPath(photoExterne) {
    const parts = photoExterne.split(/[/\\]/).filter(Boolean);
    const fileName = parts.length ? parts[parts.length - 1] : photoExterne;
    // DEST_PHOTOS est défini côté Python ; ici on lit la même racine via env ou défaut M:\PHOTOS
    const photosRoot = process.env.WEBDMP_PHOTOS || 'M:\\PHOTOS';
    let filePath = parts.length ? path.join(photosRoot, ...parts) : photoExterne;
    let existe = false;
    try {
        existe = fs.existsSync(filePath);
    }
    catch { }
    if (!existe) {
        try {
            if (fs.existsSync(photoExterne)) {
                filePath = photoExterne;
                existe = true;
            }
        }
        catch { }
    }
    return { filePath, fileName, existe };
}
let quickBusy = false;
/** Déclenché par Ctrl+Alt+D : lit le document sélectionné et ouvre la fenêtre de validation. */
async function triggerQuickDeposit() {
    if (quickBusy) {
        quickWindow?.focus();
        return;
    }
    if (quickWindow && !quickWindow.isDestroyed()) {
        quickWindow.focus();
        return;
    }
    quickBusy = true;
    try {
        logTech('Ctrl+Alt+D : lecture du document sélectionné dans StudioVision.');
        let sel;
        try {
            sel = await runPython(['--get-selected-document']);
        }
        catch (e) {
            logTech(`Lecture StudioVision : échec (${String(e)}).`);
            notify('WebDMP Assistant', 'Impossible de lire StudioVision (Access ouvert ?).');
            return;
        }
        if (!sel || sel.selected === null || !sel.photo_externe) {
            logTech('Lecture StudioVision : aucun document sélectionné.');
            notify('WebDMP Assistant', 'Aucun document sélectionné. Cliquez un document dans la fiche patient, puis Ctrl+Alt+D.');
            return;
        }
        const resolved = resolveDocPath(String(sel.photo_externe));
        logTech(`Document sélectionné : « ${sel.description} » (${resolved.fileName}) pour ${sel.nom} ${sel.prenom} (${sel.code}). `
            + `Fichier ${resolved.existe ? 'trouvé' : 'INTROUVABLE'} : ${resolved.filePath}`);
        const doc = {
            code: sel.code, nom: sel.nom, prenom: sel.prenom,
            photo_externe: sel.photo_externe, description: sel.description,
            date_str: sel.date_str, numdoc: sel.numdoc,
            type_dmp_suggere: sel.type_dmp_suggere,
            fileName: resolved.fileName, filePath: resolved.filePath, existe: resolved.existe,
            optionsHtml: (0, doctypes_1.buildDocTypeOptionsHtml)(String(sel.type_dmp_suggere || '')),
        };
        quickWindow = new electron_1.BrowserWindow({
            width: 460, height: 560, title: 'Envoyer au DMP — WebDMP Assistant',
            resizable: false, minimizable: false, maximizable: false,
            alwaysOnTop: true, skipTaskbar: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload_quick.js'),
                contextIsolation: true, nodeIntegration: false,
            },
        });
        quickWindow.removeMenu();
        quickWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'quick_deposit.html'));
        quickWindow.on('closed', () => { quickWindow = null; });
        quickWindow.webContents.once('did-finish-load', () => {
            quickWindow?.webContents.send('quick-deposit-init', doc);
        });
        logTech('Fenêtre de validation ouverte.');
    }
    finally {
        quickBusy = false;
    }
}
/** Envoi depuis la fenêtre de validation rapide. */
electron_1.ipcMain.handle('quick-deposit-send', async (_event, opts) => {
    if (depositRunning)
        return { ok: false, error: 'Un dépôt est déjà en cours.' };
    const pf = (0, replay_1.preflight)(opts);
    if (!pf.ok) {
        logTech(`Dépôt refusé avant envoi : ${pf.reason}`);
        return { ok: false, error: pf.reason };
    }
    const patientLbl = `${opts.surname}`;
    depositRunning = true;
    logTech(`Dépôt demandé : « ${opts.title} » (${opts.fileName}), type « ${opts.docTypeLabel} », patient ${patientLbl}.`);
    const emit = (info) => {
        quickWindow?.webContents.send('deposit-progress', info);
        logTech(`  [étape ${info.step}/${info.status}] ${info.detail || ''}`.trimEnd());
    };
    const win = await ensureDmpWindow(savedEcpsId, true); // tâche de fond (masquée)
    // Pendant l'authentification, la fenêtre DMP s'affiche : on la fait passer DEVANT
    // la fenêtre de validation (qui est alwaysOnTop) pour qu'on puisse valider l'e-CPS.
    // On rétablit l'ordre ensuite. (En session valide, la fenêtre DMP ne s'affiche pas.)
    const onDmpShow = () => {
        logTech('Fenêtre DMP affichée (authentification e-CPS requise).');
        if (quickWindow && !quickWindow.isDestroyed())
            quickWindow.setAlwaysOnTop(false);
        win.setAlwaysOnTop(true);
        win.moveTop();
        win.focus();
    };
    const onDmpHide = () => {
        win.setAlwaysOnTop(false);
        if (quickWindow && !quickWindow.isDestroyed()) {
            quickWindow.setAlwaysOnTop(true);
            quickWindow.moveTop();
            quickWindow.focus();
        }
    };
    win.on('show', onDmpShow);
    win.on('hide', onDmpHide);
    try {
        const res = await (0, replay_1.runDeposit)(win, opts, emit);
        if (res.ok) {
            updateTrayStatus(true);
            notify('WebDMP Assistant', `Document déposé : ${opts.fileName}`);
            logReport(`ENVOYÉ — « ${opts.title} » (${opts.fileName}) → ${patientLbl} — type « ${opts.docTypeLabel} »`);
            logTech(`Dépôt réussi : « ${opts.fileName} » → ${patientLbl}.`);
        }
        else {
            logReport(`ÉCHEC  — « ${opts.title} » (${opts.fileName}) → ${patientLbl} — motif : ${res.error || 'inconnu'}`);
            logTech(`Dépôt échoué : ${res.error || 'inconnu'}.`);
        }
        return res;
    }
    catch (err) {
        logReport(`ÉCHEC  — « ${opts.title} » (${opts.fileName}) → ${patientLbl} — erreur : ${String(err)}`);
        logTech(`Dépôt : exception ${String(err)}.`);
        return { ok: false, error: String(err) };
    }
    finally {
        depositRunning = false;
        try {
            win.removeListener('show', onDmpShow);
        }
        catch { }
        try {
            win.removeListener('hide', onDmpHide);
        }
        catch { }
    }
});
electron_1.ipcMain.on('quick-deposit-cancel', () => {
    if (quickWindow && !quickWindow.isDestroyed())
        quickWindow.close();
});
/** Charge l'identifiant e-CPS mémorisé (pour le mode service). */
function loadSavedEcpsId() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            if (cfg && typeof cfg.ecps_id === 'string')
                savedEcpsId = cfg.ecps_id;
        }
    }
    catch { /* ignore */ }
}
/** Démarre le mode service : tray, raccourci global, puis connexion e-CPS initiale. */
async function startServiceMode() {
    logTech('Démarrage du service WebDMP Assistant.');
    loadSavedEcpsId();
    setupTray();
    const ok = electron_1.globalShortcut.register(HOTKEY, () => { triggerQuickDeposit(); });
    if (ok) {
        logTech(`Raccourci ${HOTKEY} enregistré.`);
    }
    else {
        logTech(`Raccourci ${HOTKEY} NON enregistré (déjà utilisé ?).`);
        notify('WebDMP Assistant', `Le raccourci ${HOTKEY} n'a pas pu être enregistré (déjà utilisé ?).`);
    }
    // Connexion initiale fiable : vérifie la session, affiche la fenêtre PSC si besoin.
    await connectOrVerify();
}
// ── 5. LIFECYCLE ─────────────────────────────────────────────────────────────
// Identité de l'application affichée par Windows (notifications, barre des tâches).
// On ne change PAS app.name (cela déplacerait les chemins de config/journaux) :
// l'AppUserModelId suffit à corriger le nom montré dans les notifications.
electron_1.app.setAppUserModelId('WebDMP Assistant');
// Verrou mono-instance : une seule application WebDMP Assistant active à la fois.
const gotSingleInstanceLock = electron_1.app.requestSingleInstanceLock();
electron_1.app.on('second-instance', () => {
    // Une seconde exécution a été tentée : on la signale et on ramène l'existante.
    logTech('Seconde instance bloquée (mono-instance).');
    if (mainWindow) {
        if (mainWindow.isMinimized())
            mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
    else if (SERVICE_MODE) {
        notify('WebDMP Assistant', 'WebDMP Assistant est déjà actif (icône près de l\'horloge). Ctrl+Alt+D pour envoyer.');
    }
});
if (!gotSingleInstanceLock) {
    // Une instance tourne déjà : cette seconde instance se ferme immédiatement.
    electron_1.app.quit();
}
else {
    electron_1.app.whenReady().then(() => {
        // UserAgent réaliste pour éviter les blocages du portail DMP
        const dmpSession = require('electron').session.fromPartition('persist:webdmp');
        dmpSession.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        if (SERVICE_MODE) {
            startServiceMode(); // mode résident : pas de fenêtre principale
        }
        else {
            createMainWindow();
        }
    });
}
electron_1.app.on('window-all-closed', () => {
    // En mode service, on RESTE actif même sans fenêtre (la fenêtre DMP est masquée).
    if (SERVICE_MODE)
        return;
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
electron_1.app.on('activate', () => {
    if (!SERVICE_MODE && !mainWindow)
        createMainWindow();
});
electron_1.app.on('will-quit', () => {
    logTech('Arrêt de WebDMP Assistant.');
    electron_1.globalShortcut.unregisterAll();
});
//# sourceMappingURL=main.js.map