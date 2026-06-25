"use strict";
/**
 * renderer.ts — Logique de l'interface WebDMP Assistant
 */
// ── État global ───────────────────────────────────────────────────────────────
let currentPatient = null;
let documents = [];
let notes = [];
let dmpWindowOpen = false;
let activeTab = 'docs';
// ── Éléments DOM ─────────────────────────────────────────────────────────────
const api = dmpAPI;
const statusEl = document.getElementById('status');
const patientCard = document.getElementById('patient-card');
const patientNameEl = document.getElementById('patient-name');
const patientMetaEl = document.getElementById('patient-meta');
const sectionContent = document.getElementById('section-content');
const dmpStatusBar = document.getElementById('dmp-status-bar');
const dmpStatusText = document.getElementById('dmp-status-text');
const docListContainer = document.getElementById('doc-list-container');
const noteListContainer = document.getElementById('note-list-container');
const docsCountEl = document.getElementById('docs-count');
const notesCountEl = document.getElementById('notes-count');
const selectionBar = document.getElementById('selection-bar');
const selCountText = document.getElementById('sel-count-text');
const ecpsIdInput = document.getElementById('ecps-id');
// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, type) {
    if (type === 'hide') {
        statusEl.style.display = 'none';
        return;
    }
    statusEl.textContent = msg;
    statusEl.className = type;
}
function setDmpStatus(open) {
    dmpWindowOpen = open;
    if (open) {
        dmpStatusBar.classList.add('connected');
        dmpStatusText.textContent = 'Fenêtre Web DMP ouverte';
    }
    else {
        dmpStatusBar.classList.remove('connected');
        dmpStatusText.textContent = 'Fenêtre DMP fermée';
    }
}
function docIcon(nom) {
    const ext = nom.split('.').pop()?.toLowerCase() || '';
    if (ext === 'pdf')
        return '📄';
    if (['jpg', 'jpeg', 'png', 'tif', 'tiff'].includes(ext))
        return '🖼';
    if (['doc', 'docx', 'rtf'].includes(ext))
        return '📝';
    return '📎';
}
function countSelected() {
    return documents.filter(d => d.selectionne).length;
}
function updateSelectionBar() {
    const n = countSelected();
    if (n > 0) {
        selectionBar.classList.add('visible');
        selCountText.textContent = `${n} document${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`;
    }
    else {
        selectionBar.classList.remove('visible');
    }
    updateDepositButton();
}
function updateDepositButton() {
    const btn = document.getElementById('btn-deposit');
    if (!btn)
        return;
    const n = countSelected();
    btn.disabled = (n !== 1);
    btn.textContent = n === 1
        ? '📤 Envoyer le document sélectionné au DMP'
        : (n === 0 ? '📤 Sélectionnez un document à envoyer'
            : '📤 Sélectionnez un seul document');
    if (n === 1)
        prefillTitleFromSelection();
}
// ── Rendu liste de documents ──────────────────────────────────────────────────
function renderDocuments() {
    docsCountEl.textContent = String(documents.length);
    if (documents.length === 0) {
        docListContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📂</div>
        <div class="empty-msg">Aucun document trouvé</div>
        <div>Aucun PDF/image référencé dans la base pour ce patient</div>
      </div>`;
        return;
    }
    const listEl = document.createElement('div');
    listEl.className = 'doc-list';
    documents.forEach((doc, idx) => {
        const item = document.createElement('div');
        item.className = `doc-item${doc.selectionne ? ' selected' : ''}${!doc.existe ? ' doc-absent' : ''}`;
        item.innerHTML = `
      <span class="doc-icon">${docIcon(doc.nom)}</span>
      <div class="doc-info">
        <div class="doc-name" title="${escHtml(doc.nom)}">${escHtml(doc.nom)}</div>
        <div class="doc-meta">${escHtml(doc.type)} · ${escHtml(doc.date_str)} · ${escHtml(doc.taille)}${!doc.existe ? ' · ⚠ fichier absent' : ''}</div>
      </div>
      <div class="doc-check"></div>
      <div class="doc-actions">
        <button class="doc-open-btn" title="Ouvrir dans le visualiseur" data-idx="${idx}">👁</button>
      </div>`;
        // Toggle sélection au clic sur la ligne (sauf le bouton ouvrir)
        item.addEventListener('click', (e) => {
            const target = e.target;
            if (target.classList.contains('doc-open-btn'))
                return;
            documents[idx].selectionne = !documents[idx].selectionne;
            renderDocuments();
            updateSelectionBar();
        });
        // Bouton ouvrir
        item.querySelector('.doc-open-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (doc.existe) {
                api.openDocument(doc.chemin);
            }
            else {
                setStatus('⚠ Fichier introuvable sur le disque : ' + doc.chemin, 'error');
            }
        });
        listEl.appendChild(item);
    });
    docListContainer.innerHTML = '';
    docListContainer.appendChild(listEl);
    updateSelectionBar();
}
// ── Rendu liste de notes ──────────────────────────────────────────────────────
function renderNotes() {
    notesCountEl.textContent = String(notes.length);
    if (notes.length === 0) {
        noteListContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📝</div>
        <div class="empty-msg">Aucune note trouvée</div>
        <div>Aucune consultation ou observation trouvée dans la base</div>
      </div>`;
        return;
    }
    const listEl = document.createElement('div');
    listEl.className = 'note-list';
    notes.forEach((note, idx) => {
        const item = document.createElement('div');
        item.className = 'note-item';
        item.innerHTML = `
      <div class="note-header">
        <span class="note-date">${escHtml(note.date_str)}</span>
        <span class="note-titre">${escHtml(note.titre)}</span>
        <span class="note-source">${escHtml(note.source)}</span>
      </div>
      <div class="note-body">${escHtml(note.contenu || '(contenu vide)')}</div>
      <div class="note-actions">
        <button class="copy-btn" data-idx="${idx}" data-part="all">
          📋 Copier tout
        </button>
        <button class="copy-btn" data-idx="${idx}" data-part="title">
          📌 Copier le titre
        </button>
      </div>`;
        // Boutons de copie
        item.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const part = btn.dataset.part;
                let text = '';
                if (part === 'all') {
                    text = `${note.date_str} — ${note.titre}\n\n${note.contenu}`;
                }
                else {
                    text = `${note.date_str} — ${note.titre}`;
                }
                await api.copyToClipboard(text);
                const orig = btn.textContent;
                btn.textContent = '✓ Copié !';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = orig;
                    btn.classList.remove('copied');
                }, 1800);
                setStatus(`✓ Texte copié dans le presse-papier. Collez-le (Ctrl+V) dans le champ DMP.`, 'success');
            });
        });
        listEl.appendChild(item);
    });
    noteListContainer.innerHTML = '';
    noteListContainer.appendChild(listEl);
}
// ── Chargement des données patient ────────────────────────────────────────────
async function chargerDonneesPatient(code) {
    sectionContent.style.display = 'block';
    documents = [];
    notes = [];
    renderDocuments();
    renderNotes();
    docsCountEl.textContent = '…';
    notesCountEl.textContent = '…';
    setStatus('⏳ Chargement des documents et notes…', 'info');
    // Charger documents et notes en parallèle
    const [docsResult, notesResult] = await Promise.all([
        api.getPatientDocuments(code),
        api.getPatientNotes(code),
    ]);
    if (docsResult.success && Array.isArray(docsResult.docs)) {
        documents = docsResult.docs;
    }
    else if (docsResult.error) {
        console.warn('Documents error:', docsResult.error);
    }
    if (notesResult.success && Array.isArray(notesResult.notes)) {
        notes = notesResult.notes;
    }
    else if (notesResult.error) {
        console.warn('Notes error:', notesResult.error);
    }
    renderDocuments();
    renderNotes();
    const msg = `✓ ${documents.length} document${documents.length !== 1 ? 's' : ''}, `
        + `${notes.length} note${notes.length !== 1 ? 's' : ''} chargés`;
    setStatus(msg, 'success');
}
// ── Helpers HTML ──────────────────────────────────────────────────────────────
function escHtml(str) {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
// ── Afficher / effacer patient ────────────────────────────────────────────────
async function afficherPatient(patient) {
    currentPatient = patient;
    const name = [patient.prenom, patient.nom].filter(Boolean).join(' ') || `Patient ${patient.code}`;
    patientNameEl.textContent = name;
    // Charger infos complètes si on n'a que code/nom/prénom
    let meta = `Code : ${patient.code}`;
    if (patient.code) {
        try {
            const infoResult = await api.getPatientInfo(patient.code);
            if (infoResult.success && infoResult.info) {
                const info = infoResult.info;
                const parts = [`Code : ${patient.code}`];
                if (info.ddn)
                    parts.push(`DDN : ${info.ddn}`);
                if (info.ss)
                    parts.push(`NIR : ${info.ss}`);
                meta = parts.join('  ·  ');
            }
        }
        catch { }
    }
    patientMetaEl.textContent = meta;
    patientCard.classList.add('visible');
}
function effacerPatient() {
    currentPatient = null;
    patientCard.classList.remove('visible');
    patientNameEl.textContent = '—';
    patientMetaEl.textContent = '—';
    sectionContent.style.display = 'none';
    documents = [];
    notes = [];
    setStatus('hide', 'hide');
}
// ── Bouton : détecter patient ─────────────────────────────────────────────────
const btnAutoDetect = document.getElementById('btn-auto-detect');
btnAutoDetect.addEventListener('click', async () => {
    btnAutoDetect.disabled = true;
    btnAutoDetect.textContent = '⟳ Détection en cours…';
    setStatus('⏳ Lecture du patient actif dans StudioVision…', 'info');
    try {
        const result = await api.getActivePatient();
        if (result.success && result.patient?.code) {
            await afficherPatient(result.patient);
            await chargerDonneesPatient(result.patient.code);
        }
        else {
            setStatus('⚠ Aucun patient ouvert dans StudioVision, ou détection non disponible.', 'error');
        }
    }
    catch (err) {
        setStatus(`✗ Erreur détection : ${err}`, 'error');
    }
    finally {
        btnAutoDetect.disabled = false;
        btnAutoDetect.textContent = '⟳ Détecter le patient actif dans StudioVision';
    }
});
// ── Bouton : effacer patient ──────────────────────────────────────────────────
document.getElementById('btn-clear-patient').addEventListener('click', () => {
    effacerPatient();
});
// ── Bouton : Ouvrir Web DMP ───────────────────────────────────────────────────
document.getElementById('btn-open-dmp').addEventListener('click', async () => {
    const ecpsId = ecpsIdInput.value.trim();
    const result = await api.openDmpWindow(ecpsId);
    if (result.success) {
        setDmpStatus(true);
        if (ecpsId) {
            setStatus('✓ Fenêtre DMP ouverte — page Pro Santé Connect chargée, identifiant pré-rempli. Cliquez sur "SE CONNECTER AVEC E-CPS" puis validez sur votre mobile.', 'info');
        }
        else {
            setStatus('✓ Fenêtre DMP ouverte. Saisissez votre identifiant e-CPS pour vous connecter.', 'info');
        }
    }
});
// ── Bouton : Fermer Web DMP ───────────────────────────────────────────────────
document.getElementById('btn-close-dmp').addEventListener('click', async () => {
    await api.closeDmpWindow();
    setDmpStatus(false);
});
// ── Évènement : fenêtre DMP fermée de l'extérieur ────────────────────────────
api.onDmpWindowClosed(() => {
    setDmpStatus(false);
});
// ── Bouton : Sauvegarder config ───────────────────────────────────────────────
document.getElementById('btn-save-config').addEventListener('click', async () => {
    const id = ecpsIdInput.value.trim();
    const result = await api.saveConfig({ ecps_id: id });
    if (result.success) {
        setStatus('✓ Identifiant mémorisé.', 'success');
        setTimeout(() => setStatus('hide', 'hide'), 2000);
    }
});
// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        activeTab = tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
    });
});
// ── Désélectionner tout ───────────────────────────────────────────────────────
document.getElementById('btn-deselect-all').addEventListener('click', () => {
    documents.forEach(d => { d.selectionne = false; });
    renderDocuments();
    updateSelectionBar();
});
// ── Guides ────────────────────────────────────────────────────────────────────
document.getElementById('btn-guide').addEventListener('click', () => api.ouvrirGuide());
document.getElementById('btn-guide-footer').addEventListener('click', () => api.ouvrirGuide());
// ── Enregistreur d'actions Web DMP ──────────────────────────────────────────
const recDot = document.getElementById('rec-dot');
const recStatusText = document.getElementById('rec-status-text');
const recCount = document.getElementById('rec-count');
const recLast = document.getElementById('rec-last');
const recSessions = document.getElementById('rec-sessions');
const btnRecStart = document.getElementById('btn-rec-start');
const btnRecStop = document.getElementById('btn-rec-stop');
let recording = false;
function setRecordingUI(active, count = 0) {
    recording = active;
    recDot.style.background = active ? '#e5484d' : '#777';
    recDot.style.boxShadow = active ? '0 0 6px #e5484d' : 'none';
    recStatusText.textContent = active ? 'Enregistrement en cours…' : 'Enregistrement arrêté';
    recCount.textContent = count + (count > 1 ? ' actions' : ' action');
    btnRecStart.disabled = active;
    btnRecStop.disabled = !active;
}
function patientLabel() {
    if (!currentPatient)
        return '';
    const nom = [currentPatient.nom, currentPatient.prenom].filter(Boolean).join(' ');
    return currentPatient.code ? `${nom} (${currentPatient.code})` : nom;
}
btnRecStart.addEventListener('click', async () => {
    const res = await api.recorderStart(patientLabel());
    if (res.success) {
        setRecordingUI(true, 0);
        recLast.textContent = `Journal : ${res.logFile ?? ''}`;
        // Ouvrir la fenêtre DMP si pas déjà ouverte, pour enregistrer immédiatement
        if (!dmpWindowOpen) {
            await api.openDmpWindow(ecpsIdInput.value.trim());
        }
    }
    else {
        recLast.textContent = `Erreur : ${res.error ?? 'inconnue'}`;
    }
});
btnRecStop.addEventListener('click', async () => {
    const res = await api.recorderStop();
    setRecordingUI(false, 0);
    if (res.success) {
        recLast.innerHTML = `✓ Session <b>${res.id}</b> enregistrée — ${res.count} action(s).`;
        loadRecordingsList();
    }
    else {
        recLast.textContent = res.error ?? '';
    }
});
document.getElementById('btn-open-logs').addEventListener('click', () => api.openLogsFolder());
document.getElementById('btn-list-recordings').addEventListener('click', loadRecordingsList);
async function loadRecordingsList() {
    const res = await api.listRecordings();
    if (!res.success || !res.sessions.length) {
        recSessions.innerHTML = '<span style="color:var(--muted,#8a93a2)">Aucune session enregistrée pour le moment.</span>';
        return;
    }
    const fmt = (ms) => new Date(ms).toLocaleString('fr-FR');
    recSessions.innerHTML = res.sessions.slice(0, 8).map(s => `<div style="padding:5px 8px;border-radius:6px;background:var(--surface,#1b1f27);margin-bottom:4px">
       <div style="font-weight:600">${s.patient || '(patient ?)'} — ${s.actions} action(s)</div>
       <div style="color:var(--muted,#8a93a2)">${fmt(s.started)} · ${s.id}</div>
     </div>`).join('');
}
// Flux live : compteur + dernière action capturée
api.onRecorderEvent((info) => {
    if (!recording)
        setRecordingUI(true, info.count);
    recCount.textContent = info.count + (info.count > 1 ? ' actions' : ' action');
    recLast.textContent = `Dernière action : ${info.kind} (#${info.seq})`;
});
// Resynchroniser l'UI au démarrage (si un enregistrement était déjà actif)
(async () => {
    try {
        const st = await api.recorderStatus();
        if (st.recording)
            setRecordingUI(true, st.count ?? 0);
    }
    catch { }
})();
// ── Dépôt automatique sur le DMP ────────────────────────────────────────────
const depositTypeInput = document.getElementById('deposit-type');
const depositTitleInput = document.getElementById('deposit-title');
const depositVisible = document.getElementById('deposit-visible');
const depositBackground = document.getElementById('deposit-background');
const depositProgress = document.getElementById('deposit-progress');
const btnDeposit = document.getElementById('btn-deposit');
/** Pré-remplit le titre avec la description du document sélectionné (sans extension si nom de fichier). */
function prefillTitleFromSelection() {
    if (!depositTitleInput)
        return;
    const doc = documents.find(d => d.selectionne);
    if (!doc)
        return;
    if (depositTitleInput.value.trim() && depositTitleInput.dataset.auto !== '1')
        return; // ne pas écraser une saisie manuelle
    const desc = (doc.type && doc.type !== 'Document' && doc.type !== 'Image' && doc.type !== 'OCT')
        ? doc.type
        : doc.nom.replace(/\.[^.]+$/, '');
    depositTitleInput.value = desc;
    depositTitleInput.dataset.auto = '1';
}
depositTitleInput?.addEventListener('input', () => { depositTitleInput.dataset.auto = '0'; });
// Libellés lisibles pour chaque étape du moteur de rejeu
const STEP_LABELS = {
    preflight: 'Vérification du fichier',
    ecps: 'Connexion e-CPS',
    patient: 'Ouverture du DMP patient',
    ajout: 'Formulaire d\'ajout',
    fichier: 'Envoi du fichier',
    titre: 'Titre du document',
    type: 'Type de document',
    visibilite: 'Visibilité',
    soumission: 'Validation du formulaire',
    confirmation: 'Confirmation',
    signature: 'Signature & enregistrement',
    termine: 'Terminé',
    erreur: 'Erreur',
};
const stepRows = {};
function resetDepositProgress() {
    depositProgress.innerHTML = '';
    depositProgress.style.display = 'block';
    for (const k of Object.keys(stepRows))
        delete stepRows[k];
}
function renderStep(step, status, detail) {
    const icon = status === 'ok' ? '✅'
        : status === 'error' ? '❌'
            : status === 'wait' ? '⏳'
                : '⏺';
    const label = STEP_LABELS[step] || step;
    let row = stepRows[step];
    if (!row) {
        row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:3px 0;font-size:12px';
        depositProgress.appendChild(row);
        stepRows[step] = row;
    }
    const color = status === 'error' ? 'var(--red,#e5484d)'
        : status === 'ok' ? 'var(--green,#46a758)'
            : 'var(--text,#e6e6e6)';
    row.innerHTML = `<span style="width:18px">${icon}</span>`
        + `<span style="flex:1;color:${color}"><b>${label}</b>`
        + (detail ? `<br><span style="color:var(--muted,#8a93a2)">${detail}</span>` : '')
        + `</span>`;
}
btnDeposit.addEventListener('click', async () => {
    const doc = documents.find(d => d.selectionne);
    if (!doc)
        return;
    if (!currentPatient) {
        alert('Aucun patient détecté.');
        return;
    }
    const docType = depositTypeInput.value.trim();
    if (!docType) {
        depositTypeInput.focus();
        return;
    }
    const title = depositTitleInput.value.trim();
    if (!title) {
        renderStep('titre', 'error', 'Indiquez un titre pour le document (champ obligatoire).');
        depositTitleInput.focus();
        return;
    }
    if (!doc.existe) {
        renderStep('preflight', 'error', `Le fichier est introuvable sur le disque : ${doc.chemin}`);
        return;
    }
    // Mémoriser le type choisi pour la prochaine fois
    try {
        await api.saveConfig({ ecps_id: ecpsIdInput.value.trim(), last_doctype: docType });
    }
    catch { }
    btnDeposit.disabled = true;
    resetDepositProgress();
    renderStep('ecps', 'wait', 'Ouverture du DMP…');
    const res = await api.dmpDeposit({
        surname: currentPatient.nom,
        filePath: doc.chemin,
        fileName: doc.nom,
        title: title,
        docTypeLabel: docType,
        visible: depositVisible.checked,
        background: depositBackground.checked,
        closeWhenDone: false,
        ecpsId: ecpsIdInput.value.trim(),
    });
    if (!res.ok && res.error)
        renderStep('erreur', 'error', res.error);
    btnDeposit.disabled = false;
    updateDepositButton();
});
// Progression live du moteur de rejeu
api.onDepositProgress((info) => {
    renderStep(info.step, info.status, info.detail);
});
(async () => {
    try {
        const result = await api.loadConfig();
        if (result.success && result.config?.ecps_id) {
            ecpsIdInput.value = result.config.ecps_id;
        }
        if (result.success && result.config?.last_doctype) {
            const di = document.getElementById('deposit-type');
            if (di)
                di.value = result.config.last_doctype;
        }
    }
    catch { }
})();
// ── Récupération de l'INS (INSi) — assistant pas à pas ───────────────────────
// Étapes pilotées par bouton, calquées sur le flux « Détecter le patient » :
//   1. Détecter le sous-formulaire « CARACTERISTIQUES PATIENT » (présence INSi)
//   2. Appel INSi (clic INSi → dialogue de validation)
//   3. Valider l'appel (clic OK → lecture de la « Réponse INSi ») → champ N° INS
const insiStatus = document.getElementById('insi-status');
const btnInsiDetect = document.getElementById('btn-insi-detect');
const insiStepCall = document.getElementById('insi-step-call');
const btnInsiCall = document.getElementById('btn-insi-call');
const insiStepValidate = document.getElementById('insi-step-validate');
const btnInsiValidate = document.getElementById('btn-insi-validate');
const insiResult = document.getElementById('insi-result');
const insiInsInput = document.getElementById('insi-ins');
const insiIdentity = document.getElementById('insi-identity');
const btnInsiCopy = document.getElementById('btn-insi-copy');
const btnInsiReset = document.getElementById('btn-insi-reset');
function setInsiStatus(msg, type) {
    if (!insiStatus)
        return;
    if (type === 'hide') {
        insiStatus.style.display = 'none';
        return;
    }
    insiStatus.textContent = msg;
    insiStatus.className = 'insi-status ' + type;
}
/** Affiche/masque les étapes en cascade. step: 'call' | 'validate' | 'result' | 'none'. */
function showInsiStep(step) {
    insiStepCall.classList.toggle('visible', step === 'call' || step === 'validate' || step === 'result');
    insiStepValidate.classList.toggle('visible', step === 'validate' || step === 'result');
    insiResult.classList.toggle('visible', step === 'result');
}
function resetInsi() {
    showInsiStep('none');
    insiInsInput.value = '';
    insiIdentity.textContent = '';
    setInsiStatus('hide', 'hide');
    btnInsiCall.disabled = false;
    btnInsiValidate.disabled = false;
}
// Étape 1 — Détecter le sous-formulaire « CARACTERISTIQUES PATIENT »
btnInsiDetect?.addEventListener('click', async () => {
    btnInsiDetect.disabled = true;
    const orig = btnInsiDetect.textContent;
    btnInsiDetect.textContent = '⟳ Détection en cours…';
    // Re-détecter réinitialise les étapes suivantes
    showInsiStep('none');
    insiInsInput.value = '';
    insiIdentity.textContent = '';
    setInsiStatus('⏳ Recherche du sous-formulaire « CARACTERISTIQUES PATIENT »…', 'info');
    try {
        const res = await api.insiDetectForm();
        if (res.ok && res.present) {
            setInsiStatus(`✓ Sous-formulaire détecté${res.form_title ? ' (« ' + res.form_title + ' »)' : ''}. Vous pouvez lancer l'appel INSi.`, 'success');
            showInsiStep('call');
        }
        else if (res.ok && !res.present) {
            setInsiStatus('⚠ Sous-formulaire « CARACTERISTIQUES PATIENT » non ouvert. Dans StudioVision, double-cliquez le champ d\'identité du patient pour l\'ouvrir, puis relancez la détection.', 'error');
        }
        else {
            setInsiStatus(`✗ ${res.error || 'Détection impossible.'}`, 'error');
        }
    }
    catch (err) {
        setInsiStatus(`✗ Erreur de détection : ${err}`, 'error');
    }
    finally {
        btnInsiDetect.disabled = false;
        btnInsiDetect.textContent = orig;
    }
});
// Étape 2 — Appel INSi (clic INSi → dialogue de validation)
btnInsiCall?.addEventListener('click', async () => {
    btnInsiCall.disabled = true;
    const orig = btnInsiCall.textContent;
    btnInsiCall.textContent = '⟳ Appel en cours…';
    // Relancer l'appel réinitialise l'étape de validation
    insiStepValidate.classList.remove('visible');
    insiResult.classList.remove('visible');
    setInsiStatus('⏳ Clic sur le bouton INSi… (carte CPS et lecteur prêts ?)', 'info');
    try {
        const res = await api.insiClick();
        if (res.ok && res.dialog) {
            setInsiStatus('✓ Appel INSi effectué — dialogue de validation affiché. Cliquez sur « Valider l\'appel ».', 'success');
            showInsiStep('validate');
        }
        else {
            setInsiStatus(`✗ ${res.error || 'Le dialogue de validation n\'est pas apparu.'}`, 'error');
        }
    }
    catch (err) {
        setInsiStatus(`✗ Erreur pendant l'appel INSi : ${err}`, 'error');
    }
    finally {
        btnInsiCall.disabled = false;
        btnInsiCall.textContent = orig;
    }
});
// Étape 3 — Valider l'appel (clic OK → lecture de la « Réponse INSi »)
btnInsiValidate?.addEventListener('click', async () => {
    btnInsiValidate.disabled = true;
    const orig = btnInsiValidate.textContent;
    btnInsiValidate.textContent = '⟳ Validation et lecture…';
    setInsiStatus('⏳ Validation (OK) et lecture de la réponse du téléservice INSi…', 'info');
    try {
        const res = await api.insiValidate();
        if (res.ok && res.ins) {
            insiInsInput.value = res.ins;
            const ident = [
                [res.prenoms, res.nom].filter(Boolean).join(' '),
                res.sexe ? `sexe ${res.sexe}` : '',
                res.date_naissance ? `né(e) le ${res.date_naissance}` : '',
                res.lieu_naissance || '',
            ].filter(Boolean).join('  ·  ');
            insiIdentity.textContent = ident;
            showInsiStep('result');
            setInsiStatus('✓ INS récupéré et inscrit dans le champ ci-dessous.', 'success');
            // Copie automatique dans le presse-papier (pratique pour coller ailleurs)
            try {
                await api.copyToClipboard(res.ins);
            }
            catch { }
        }
        else {
            setInsiStatus(`✗ ${res.error || 'Lecture de la réponse INSi impossible.'}`, 'error');
        }
    }
    catch (err) {
        setInsiStatus(`✗ Erreur pendant la validation : ${err}`, 'error');
    }
    finally {
        btnInsiValidate.disabled = false;
        btnInsiValidate.textContent = orig;
    }
});
// Copier le n° INS
btnInsiCopy?.addEventListener('click', async () => {
    if (!insiInsInput.value)
        return;
    await api.copyToClipboard(insiInsInput.value);
    const orig = btnInsiCopy.textContent;
    btnInsiCopy.textContent = '✓ Copié !';
    setTimeout(() => { btnInsiCopy.textContent = orig; }, 1600);
});
// Recommencer
btnInsiReset?.addEventListener('click', resetInsi);
//# sourceMappingURL=renderer.js.map