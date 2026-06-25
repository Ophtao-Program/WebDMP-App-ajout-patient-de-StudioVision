"use strict";
/**
 * preload.ts — Bridge sécurisé entre main et renderer
 * Expose uniquement les APIs nécessaires via contextBridge.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('dmpAPI', {
    /** Lit le patient actuellement ouvert dans StudioVision via COM */
    getActivePatient: () => electron_1.ipcRenderer.invoke('get-active-patient'),
    /** Infos administratives d'un patient (nom, prénom, DDN, SS/INS) */
    getPatientInfo: (code) => electron_1.ipcRenderer.invoke('get-patient-info', code),
    /** Liste les derniers documents PDF/images du patient depuis la base Access */
    getPatientDocuments: (code) => electron_1.ipcRenderer.invoke('get-patient-documents', code),
    /** Lit les dernières notes/observations du patient */
    getPatientNotes: (code) => electron_1.ipcRenderer.invoke('get-patient-notes', code),
    // ── Récupération de l'INS (INSi via StudioVision) ───────────────────────
    /** Étape 1 — vérifie si le sous-formulaire « CARACTERISTIQUES PATIENT » est ouvert. */
    insiDetectForm: () => electron_1.ipcRenderer.invoke('insi-detect-form'),
    /** Étape 2 — clique le bouton INSi et attend le dialogue de validation. */
    insiClick: () => electron_1.ipcRenderer.invoke('insi-click'),
    /** Étape 3 — valide (OK) et lit l'INS dans la fenêtre « Réponse INSi ». */
    insiValidate: () => electron_1.ipcRenderer.invoke('insi-validate'),
    /** Ouvre (ou focus) la fenêtre Web DMP — va directement sur Pro Santé Connect et pré-remplit l'identifiant */
    openDmpWindow: (ecpsId) => electron_1.ipcRenderer.invoke('open-dmp-window', ecpsId),
    /** Ferme la fenêtre Web DMP */
    closeDmpWindow: () => electron_1.ipcRenderer.invoke('close-dmp-window'),
    /** Copie un texte dans le presse-papier */
    copyToClipboard: (text) => electron_1.ipcRenderer.invoke('copy-to-clipboard', text),
    /** Ouvre un fichier document dans l'application par défaut */
    openDocument: (chemin) => electron_1.ipcRenderer.invoke('open-document', chemin),
    /** Guide d'utilisation */
    ouvrirGuide: () => electron_1.ipcRenderer.invoke('ouvrir-guide'),
    /** Sauvegarde la configuration locale */
    saveConfig: (config) => electron_1.ipcRenderer.invoke('save-config', config),
    /** Charge la configuration locale */
    loadConfig: () => electron_1.ipcRenderer.invoke('load-config'),
    /** Reçoit les événements de navigation depuis la fenêtre DMP */
    onDmpUrlChanged: (cb) => {
        electron_1.ipcRenderer.on('dmp-url-changed', (_event, url) => cb(url));
    },
    /** Notifie quand la fenêtre DMP est fermée */
    onDmpWindowClosed: (cb) => {
        electron_1.ipcRenderer.on('dmp-window-closed', () => cb());
    },
    // ── Enregistreur d'actions Web DMP ──────────────────────────────────────
    /** Démarre l'enregistrement des actions (patientLabel = en-tête du journal) */
    recorderStart: (patientLabel) => electron_1.ipcRenderer.invoke('recorder-start', patientLabel),
    /** Arrête l'enregistrement et renvoie le récapitulatif */
    recorderStop: () => electron_1.ipcRenderer.invoke('recorder-stop'),
    /** État courant de l'enregistreur */
    recorderStatus: () => electron_1.ipcRenderer.invoke('recorder-status'),
    /** Ouvre le dossier des journaux dans l'explorateur */
    openLogsFolder: () => electron_1.ipcRenderer.invoke('open-logs-folder'),
    /** Liste les sessions déjà enregistrées */
    listRecordings: () => electron_1.ipcRenderer.invoke('list-recordings'),
    /** Flux live des actions capturées (compteur + type) */
    onRecorderEvent: (cb) => {
        electron_1.ipcRenderer.on('recorder-event', (_event, info) => cb(info));
    },
    // ── Dépôt automatique sur le DMP ────────────────────────────────────────
    /** Lance le dépôt automatique d'un document (ouvre le DMP, attend e-CPS, automatise la suite) */
    dmpDeposit: (opts) => electron_1.ipcRenderer.invoke('dmp-deposit', opts),
    /** Lit les types de documents proposés par le portail (page d'ajout ouverte) */
    readDocTypes: () => electron_1.ipcRenderer.invoke('dmp-read-doctypes'),
    /** Progression du dépôt automatique, étape par étape */
    onDepositProgress: (cb) => {
        electron_1.ipcRenderer.on('deposit-progress', (_event, info) => cb(info));
    },
});
//# sourceMappingURL=preload.js.map