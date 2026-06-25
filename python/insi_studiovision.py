#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
insi_studiovision.py — Recuperation de l'INS depuis StudioVision (pywin32 + COM)

Implementation SANS uiautomation. On s'appuie uniquement sur :
  * COM (win32com / Access.Application via la Running Object Table) pour parler
    au formulaire Access et donner le focus au bouton INSi ;
  * l'API Win32 (ctypes user32) pour piloter les dialogues Windows standard
    (#32770) : clic OK, lecture des champs et du texte de reponse.

Pourquoi ce decoupage (cartographie StudioVision du 25/06/2026) :
  * Le bouton INSi est « Commande136 » (Caption='INSi'), OnClick='[Event
    Procedure]' : c'est une procedure evenementielle PRIVEE d'Access, donc NON
    appelable via Application.Run / DoCmd. On lui donne le focus en COM puis on
    envoie une frappe clavier (Espace) -> aucun parcours d'arbre d'accessibilite.
  * Le dialogue de validation « Identifiant National de Sante - traits
    d'identite » et la fenetre « StudioVision - Reponse INSi » sont de VRAIES
    boites Windows (#32770). Leurs controles sont de vrais HWND : on lit/clique
    par message Win32 (WM_GETTEXT, BM_CLICK), ce qui est immediat et robuste.

MODES (un seul a la fois) — pensee pour l'assistant Electron, qui pilote chaque
etape par un bouton distinct, dans des PROCESSUS SEPARES. Les fenetres
StudioVision et les dialogues Windows persistent entre les appels : on les
retrouve a chaque fois par leur classe / leur titre / leur identifiant COM.

  --detect-form     Verifie si le sous-formulaire « CARACTERISTIQUES PATIENT »
                    est ouvert (presence du bouton INSi). NE CLIQUE RIEN.
                    -> {"ok": true, "present": bool, "form_title": "..."}

  --click-insi      Donne le focus au bouton INSi puis l'active (Espace/Entree)
                    et attend le dialogue « Identifiant National de Sante... ».
                    -> {"ok": true, "dialog": true}   (= activation reussie)

  --validate-read   Lit les traits du dialogue de validation, clique OK, attend
                    la fenetre « Reponse INSi » et lit l'INS.
                    -> {"ok": true, "ins": "...", "nom": "...", "prenoms": "...",
                        "sexe": "...", "date_naissance": "...", "lieu_naissance":
                        "...", "oid": "..."}

  --get-ins         Enchaine --click-insi puis --validate-read (sous-formulaire
                    suppose deja ouvert). Conserve pour le raccourci global.

  --diagnostic      Liste les fenetres detectees (depannage, chiffres masques).

Sortie : un objet JSON sur stdout. En cas d'echec : {"ok": false, "error": "..."}.
Toute trace technique part sur stderr (reprise par Electron) ; l'INS n'y figure
JAMAIS (donnee d'identite de sante) : on ne loge que « INS recupere (N chiffres) ».

Prerequis : Windows, Python 3.8+, pip install pywin32
A lancer NORMALEMENT (pas « en tant qu'administrateur ») : StudioVision tourne
en utilisateur normal et un programme eleve ne peut ni l'attacher en COM ni
piloter son interface.
"""

from __future__ import annotations

import sys
import json
import time
import re

# Sortie UTF-8 (evite le mojibake des accents cote Electron)
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# ── Identifiants d'interface (cartographie StudioVision 25/06/2026) ───────────
OMAIN_CLASS       = "OMain"                     # fenetre principale StudioVision
SUBFORM_CLASS     = "OFormPopup"                # classe du sous-formulaire (HWND)
SUBFORM_FORM_NAME = "CARACTERISTIQUES PATIENT"  # Name COM du sous-formulaire
INSI_BTN_NAME     = "Commande136"               # bouton INSi (Caption='INSi')
INSI_BTN_CAPTION  = "INSi"                       # repli : recherche par Caption

DIALOG_HINT   = "Identifiant National de Sant"   # dialogue de validation (#32770)
RESPONSE_HINT = "ponse INSi"                      # « Reponse INSi » (sans accent initial)
DLG_CLASS     = "#32770"                          # classe Windows des deux dialogues

# Dialogue de validation « ... traits d'identite » -> identifiants de controles
VAL_OK_ID    = 1      # bouton OK
VAL_NOM      = 500    # Edit Nom
VAL_PRENOM   = 501    # Edit Prenom
VAL_LIEU     = 502    # Edit Lieu de naissance
VAL_SEXE     = 503    # Edit Sexe
VAL_DOB_D    = 900    # Edit jour de naissance
VAL_DOB_M    = 901    # Edit mois de naissance
VAL_DOB_Y    = 902    # Edit annee de naissance

# Fenetre « Reponse INSi »
RESP_OK_ID   = 2       # bouton OK (id 2 dans cette boite)
RESP_TEXT_ID = 65535   # Static porteur du bloc « cle=valeur » (Reponse/INS/OID)

# ── Delais (secondes) ─────────────────────────────────────────────────────────
CLICK_CONFIRM = 6      # apparition du dialogue de validation apres activation
WAIT_REPONSE  = 40     # apparition de la fenetre Reponse INSi (teleservice)
WAIT_SHORT    = 4      # presence d'un dialogue deja affiche / re-acquisition

# ── Frappes clavier / messages Win32 ──────────────────────────────────────────
VK_SPACE         = 0x20
VK_RETURN        = 0x0D
KEYEVENTF_KEYUP  = 0x0002
WM_GETTEXT       = 0x000D
WM_GETTEXTLENGTH = 0x000E
WM_COMMAND       = 0x0111
BM_CLICK         = 0x00F5


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def log(msg: str) -> None:
    # Trace vers stderr -> reprise dans le journal technique par Electron.
    # IMPORTANT : ne jamais ecrire l'INS ici (donnee d'identite de sante).
    sys.stderr.write("[insi] " + msg + "\n")
    sys.stderr.flush()


HAS_WIN = sys.platform.startswith("win")

# ══════════════════════════════════════════════════════════════════════════════
#  Couche Win32 (ctypes user32) — uniquement chargee sous Windows
# ══════════════════════════════════════════════════════════════════════════════
if HAS_WIN:
    import ctypes
    from ctypes import wintypes

    user32   = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.EnumChildWindows.argtypes = [wintypes.HWND, EnumWindowsProc, wintypes.LPARAM]
    user32.EnumChildWindows.restype = wintypes.BOOL
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetDlgItem.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetDlgItem.restype = wintypes.HWND
    # lParam en c_void_p : accepte un entier OU un buffer (adresse) pour WM_GETTEXT
    user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_void_p]
    user32.SendMessageW.restype = ctypes.c_ssize_t
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_void_p]
    user32.PostMessageW.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.BringWindowToTop.restype = wintypes.BOOL
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, wintypes.LPDWORD]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.AttachThreadInput.restype = wintypes.BOOL
    user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_void_p]
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD

    def _enum(parent: int = 0) -> list:
        """HWND des fenetres de premier niveau (parent=0) ou des enfants directs."""
        out: list = []

        @EnumWindowsProc
        def _cb(h, _l):
            out.append(h)
            return True

        if parent:
            user32.EnumChildWindows(parent, _cb, 0)
        else:
            user32.EnumWindows(_cb, 0)
        return out

    def get_class(h: int) -> str:
        buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(h, buf, 256)
        return buf.value or ""

    def get_title(h: int) -> str:
        n = user32.GetWindowTextLengthW(h)
        if n <= 0:
            return ""
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(h, buf, n + 1)
        return buf.value or ""

    def wm_get_text(h: int) -> str:
        """Lit le texte d'un controle d'un AUTRE processus (WM_GETTEXT explicite)."""
        if not h:
            return ""
        n = user32.SendMessageW(h, WM_GETTEXTLENGTH, 0, 0)
        if n <= 0:
            return ""
        buf = ctypes.create_unicode_buffer(int(n) + 1)
        user32.SendMessageW(h, WM_GETTEXT, int(n) + 1, buf)
        return buf.value or ""

    def find_window(class_sub: str = "", title_sub: str = "", visible_only: bool = True) -> int:
        for h in _enum():
            if visible_only and not user32.IsWindowVisible(h):
                continue
            if class_sub and class_sub.lower() not in get_class(h).lower():
                continue
            if title_sub and title_sub.lower() not in get_title(h).lower():
                continue
            return h
        return 0

    def find_omain() -> int:
        return find_window(class_sub=OMAIN_CLASS)

    def find_oformpopup() -> int:
        """Sous-formulaire : fenetre de premier niveau, sinon enfant de OMain."""
        h = find_window(class_sub=SUBFORM_CLASS)
        if h:
            return h
        hom = find_omain()
        if hom:
            for c in _enum(hom):
                if SUBFORM_CLASS.lower() in get_class(c).lower():
                    return c
        return 0

    def wait_window(predicate, timeout: float, interval: float = 0.3) -> int:
        end = time.time() + timeout
        while time.time() < end:
            h = predicate()
            if h:
                return h
            time.sleep(interval)
        return predicate()

    def dlg_item_text(hdlg: int, ctrl_id: int) -> str:
        return wm_get_text(user32.GetDlgItem(hdlg, ctrl_id)).strip()

    def click_dlg_button(hdlg: int, ctrl_id: int) -> bool:
        h = user32.GetDlgItem(hdlg, ctrl_id)
        if h:
            user32.SendMessageW(h, BM_CLICK, 0, 0)
            return True
        # repli : notifier le dialogue (WM_COMMAND, BN_CLICKED=0 -> wParam=id)
        return bool(user32.PostMessageW(hdlg, WM_COMMAND, ctrl_id, 0))

    def read_response_static(hresp: int) -> str:
        """Texte « cle=valeur » de la fenetre Reponse INSi (Static id 65535)."""
        # 1) chemin direct par identifiant de controle
        txt = wm_get_text(user32.GetDlgItem(hresp, RESP_TEXT_ID))
        if txt and "INS=" in txt:
            return txt
        # 2) repli : balayer les enfants et garder celui qui contient « INS= »
        for c in _enum(hresp):
            t = wm_get_text(c)
            if t and "INS=" in t:
                return t
        return txt or ""

    def force_foreground(hwnd: int) -> bool:
        """Passe hwnd au premier plan (contournement AttachThreadInput)."""
        try:
            fg = user32.GetForegroundWindow()
            if fg == hwnd:
                return True
            cur = kernel32.GetCurrentThreadId()
            fg_thr = user32.GetWindowThreadProcessId(fg, None) if fg else 0
            tgt_thr = user32.GetWindowThreadProcessId(hwnd, None)
            if fg_thr:
                user32.AttachThreadInput(cur, fg_thr, True)
            user32.AttachThreadInput(cur, tgt_thr, True)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            if fg_thr:
                user32.AttachThreadInput(cur, fg_thr, False)
            user32.AttachThreadInput(cur, tgt_thr, False)
            return user32.GetForegroundWindow() == hwnd
        except Exception as e:
            log("force_foreground: %s" % e)
            return False

    def press_key(vk: int) -> None:
        user32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.03)
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)


# ══════════════════════════════════════════════════════════════════════════════
#  Couche COM (win32com / Access.Application) — chargee paresseusement
# ══════════════════════════════════════════════════════════════════════════════
def co_init() -> None:
    try:
        import pythoncom
        pythoncom.CoInitialize()
    except Exception:
        pass


def _is_access_app(obj) -> bool:
    try:
        _ = obj.CurrentProject
        _ = obj.Forms.Count
        return True
    except Exception:
        return False


def list_access_instances() -> list:
    """Instances Access du Running Object Table -> [{app, forms, project}]."""
    found: list = []
    try:
        import pythoncom
        import win32com.client as win32
    except Exception:
        return found
    try:
        rot = pythoncom.GetRunningObjectTable()
        ctx = pythoncom.CreateBindCtx(0)
        for moniker in rot.EnumRunning():
            try:
                raw = rot.GetObject(moniker)
                app = win32.Dispatch(raw.QueryInterface(pythoncom.IID_IDispatch))
            except Exception:
                continue
            if not _is_access_app(app):
                continue
            try:
                fc = int(app.Forms.Count)
            except Exception:
                fc = -1
            try:
                proj = str(app.CurrentProject.Name)
            except Exception:
                proj = ""
            found.append({"app": app, "forms": fc, "project": proj})
    except Exception as e:
        log("Enumeration ROT impossible: %s" % e)
    return found


def access_app():
    """Instance Access la plus pertinente (formulaires ouverts / projet)."""
    co_init()
    insts = list_access_instances()
    if insts:
        insts.sort(key=lambda d: (d["forms"] > 0, bool(d["project"]), d["forms"]), reverse=True)
        best = insts[0]
        if best["forms"] > 0 or best["project"]:
            return best["app"]
    try:
        import win32com.client as win32
        return win32.GetActiveObject("Access.Application")
    except Exception:
        return insts[0]["app"] if insts else None


def find_caracteristiques_form(acc):
    """Le formulaire « CARACTERISTIQUES PATIENT » s'il est ouvert, sinon None."""
    try:
        forms = acc.Forms
        n = int(forms.Count)
    except Exception:
        return None
    for i in range(n):
        try:
            f = forms(i)
            if str(f.Name).strip().upper() == SUBFORM_FORM_NAME.upper():
                return f
        except Exception:
            continue
    return None


def find_insi_control(form):
    """Le bouton INSi (Commande136 / Caption='INSi') du formulaire, sinon None."""
    try:
        c = form.Controls(INSI_BTN_NAME)
        if c is not None:
            return c
    except Exception:
        pass
    try:
        ctrls = form.Controls
        for i in range(int(ctrls.Count)):
            try:
                c = ctrls(i)
                if str(getattr(c, "Caption", "")).strip().upper() == INSI_BTN_CAPTION.upper():
                    return c
            except Exception:
                continue
    except Exception:
        pass
    return None


# ══════════════════════════════════════════════════════════════════════════════
#  Lecture / validation de la reponse (logique inchangee)
# ══════════════════════════════════════════════════════════════════════════════
def parse_response(text: str) -> dict:
    """Transforme le bloc « cle=valeur » de la Reponse INSi en dict structure."""
    fields: dict = {}
    norm = text.replace("\\r\\n", "\n").replace("\r\n", "\n").replace("\r", "\n")
    for line in norm.split("\n"):
        if "=" in line:
            k, v = line.split("=", 1)
            fields[k.strip()] = v.strip()
    return fields


def build_ins_result(fields: dict) -> dict:
    """Valide la reponse et construit le resultat (ou un echec explicite)."""
    ins = re.sub(r"\D", "", fields.get("INS", ""))
    rep = fields.get("Reponse", "")
    code = fields.get("code", "")
    if rep and rep.upper() != "OK":
        return {"ok": False,
                "error": "Reponse INSi non concluante (Reponse=%s, code=%s)." % (rep, code)}
    if len(ins) != 15:
        return {"ok": False,
                "error": "INS de longueur inattendue (%d chiffres au lieu de 15)." % len(ins)}
    return {
        "ok": True,
        "ins": ins,
        "nom": fields.get("Nom", ""),
        "prenoms": fields.get("Prenoms", ""),
        "sexe": fields.get("Sexe", ""),
        "date_naissance": fields.get("Date_naissance", ""),
        "lieu_naissance": fields.get("Lieu_naissance", ""),
        "oid": fields.get("OID", ""),
    }


def read_validation_traits(hval: int) -> dict:
    """Lit Nom/Prenom/Sexe/Date/Lieu dans le dialogue de validation (#32770)."""
    fields: dict = {}
    nom = dlg_item_text(hval, VAL_NOM)
    pre = dlg_item_text(hval, VAL_PRENOM)
    lieu = dlg_item_text(hval, VAL_LIEU)
    sexe = dlg_item_text(hval, VAL_SEXE)
    j = dlg_item_text(hval, VAL_DOB_D)
    m = dlg_item_text(hval, VAL_DOB_M)
    a = dlg_item_text(hval, VAL_DOB_Y)
    if nom:
        fields["Nom"] = nom
    if pre:
        fields["Prenoms"] = pre
    if lieu:
        fields["Lieu_naissance"] = lieu
    if sexe:
        fields["Sexe"] = sexe
    if j or m or a:
        fields["Date_naissance"] = "%s/%s/%s" % (j, m, a)
    return fields


def close_response_and_subform(hresp: int) -> None:
    """Ferme la fenetre Reponse (OK) puis le sous-formulaire (best effort)."""
    try:
        click_dlg_button(hresp, RESP_OK_ID)
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════════════════════
#  Operations composables
# ══════════════════════════════════════════════════════════════════════════════
def do_click_insi(acc) -> tuple:
    """Donne le focus au bouton INSi et l'active. -> (True, None) | (False, err)."""
    form = find_caracteristiques_form(acc)
    if form is None:
        return False, ("Sous-formulaire « CARACTERISTIQUES PATIENT » non ouvert. "
                       "Ouvrez-le dans StudioVision (double-clic sur le champ identite) "
                       "puis relancez la detection.")
    btn = find_insi_control(form)
    if btn is None:
        return False, "Bouton INSi (Commande136) introuvable dans le sous-formulaire."

    # Focus via COM (le formulaire doit etre actif pour focaliser un controle)
    try:
        form.SetFocus()
    except Exception as e:
        log("form.SetFocus a echoue: %s" % e)
    focused = False
    try:
        btn.SetFocus()
        focused = True
    except Exception as e:
        log("btn.SetFocus a echoue: %s" % e)
    time.sleep(0.25)

    # Premier plan de StudioVision pour que la frappe atteigne le bouton focalise
    hwnd = find_oformpopup() or find_omain()
    if hwnd:
        force_foreground(hwnd)
        time.sleep(0.15)
    else:
        log("Fenetre StudioVision (OFormPopup/OMain) introuvable pour le premier plan.")

    if not focused:
        log("Focus COM non confirme : activation au clavier tentee quand meme.")

    # Activer le bouton focalise : Espace, puis Entree en repli
    for vk, label in ((VK_SPACE, "Espace"), (VK_RETURN, "Entree")):
        press_key(vk)
        h = wait_window(lambda: find_window(class_sub=DLG_CLASS, title_sub=DIALOG_HINT),
                        CLICK_CONFIRM)
        if h:
            return True, None
        log("Dialogue de validation absent apres « %s » ; nouvelle tentative." % label)

    return False, ("Dialogue de validation INSi non apparu apres activation du bouton "
                   "(carte CPS lue ? bouton bien focalise ?).")


def do_validate_read() -> dict:
    """Lit les traits, clique OK, lit la Reponse INSi. -> dict resultat final."""
    hval = wait_window(lambda: find_window(class_sub=DLG_CLASS, title_sub=DIALOG_HINT),
                       WAIT_SHORT)
    if not hval:
        return {"ok": False,
                "error": "Dialogue de validation « Identifiant National de Sante » introuvable : "
                         "lancez d'abord « Appel INSi »."}

    # 1) Traits d'identite (avant de cliquer OK)
    fields = read_validation_traits(hval)

    # 2) Valider (OK = id 1)
    if not click_dlg_button(hval, VAL_OK_ID):
        return {"ok": False, "error": "Impossible de cliquer OK sur le dialogue de validation."}

    # 3) Fenetre Reponse INSi -> lecture du contenu
    hresp = wait_window(lambda: find_window(class_sub=DLG_CLASS, title_sub=RESPONSE_HINT),
                        WAIT_REPONSE)
    if not hresp:
        return {"ok": False,
                "error": "Fenetre « Reponse INSi » non apparue (teleservice INSi en echec ?)."}
    text = read_response_static(hresp)
    close_response_and_subform(hresp)

    if not text:
        return {"ok": False, "error": "Reponse INSi illisible (texte vide)."}

    fields.update(parse_response(text))
    return build_ins_result(fields)


# ══════════════════════════════════════════════════════════════════════════════
#  Commandes (un mode = un processus, pilote par l'assistant Electron)
# ══════════════════════════════════════════════════════════════════════════════
def _guard() -> int:
    emit({"ok": False, "error": "Disponible uniquement sous Windows (pywin32 requis)."})
    return 0


def cmd_detect_form() -> int:
    if not HAS_WIN:
        return _guard()
    acc = access_app()
    if acc is None:
        emit({"ok": False,
              "error": "StudioVision (Access) introuvable via COM. Est-il demarre ? "
                       "Le lancement doit etre SANS administrateur."})
        return 0
    form = find_caracteristiques_form(acc)
    if form is None:
        emit({"ok": True, "present": False, "form_title": ""})
        return 0
    btn = find_insi_control(form)
    present = False
    if btn is not None:
        try:
            present = bool(btn.Visible)
        except Exception:
            present = True
    emit({"ok": True, "present": present, "form_title": SUBFORM_FORM_NAME if present else ""})
    return 0


def cmd_click_insi() -> int:
    if not HAS_WIN:
        return _guard()
    acc = access_app()
    if acc is None:
        emit({"ok": False,
              "error": "StudioVision (Access) introuvable via COM (sous-formulaire ferme ? "
                       "lance en administrateur ?)."})
        return 0
    log("Activation du bouton INSi.")
    ok, err = do_click_insi(acc)
    if not ok:
        emit({"ok": False, "error": err})
        return 0
    emit({"ok": True, "dialog": True})
    return 0


def cmd_validate_read() -> int:
    if not HAS_WIN:
        return _guard()
    log("Validation de l'appel et lecture de la reponse INSi.")
    result = do_validate_read()
    if result.get("ok"):
        log("INS recupere (%d chiffres)." % len(result.get("ins", "")))
    emit(result)
    return 0


def cmd_get_ins() -> int:
    """Enchainement complet (sous-formulaire suppose deja ouvert)."""
    if not HAS_WIN:
        return _guard()
    acc = access_app()
    if acc is None:
        emit({"ok": False, "error": "StudioVision (Access) introuvable via COM."})
        return 0
    ok, err = do_click_insi(acc)
    if not ok:
        emit({"ok": False, "error": err})
        return 0
    result = do_validate_read()
    if result.get("ok"):
        log("INS recupere (%d chiffres)." % len(result.get("ins", "")))
    emit(result)
    return 0


def _mask_digits(s: str) -> str:
    return re.sub(r"\d", "•", s or "")


def cmd_diagnostic() -> int:
    if not HAS_WIN:
        return _guard()
    co_init()
    windows = []
    try:
        for h in _enum():
            if not user32.IsWindowVisible(h):
                continue
            cls = get_class(h)
            if cls in (OMAIN_CLASS, DLG_CLASS, SUBFORM_CLASS):
                windows.append({"class": cls, "title": _mask_digits(get_title(h))})
        # sous-formulaire eventuellement enfant de OMain
        hom = find_omain()
        if hom:
            for c in _enum(hom):
                if get_class(c) == SUBFORM_CLASS:
                    windows.append({"class": SUBFORM_CLASS, "title": _mask_digits(get_title(c)),
                                    "parent": "OMain"})
    except Exception as e:
        emit({"ok": False, "error": "Diagnostic impossible : %s" % e})
        return 0

    # Contexte COM (sans donnee sensible)
    com_ctx = {}
    try:
        acc = access_app()
        if acc is not None:
            try:
                com_ctx["projet"] = str(acc.CurrentProject.Name)
            except Exception:
                com_ctx["projet"] = ""
            try:
                com_ctx["formulaires_ouverts"] = int(acc.Forms.Count)
            except Exception:
                com_ctx["formulaires_ouverts"] = -1
            com_ctx["sous_formulaire_present"] = find_caracteristiques_form(acc) is not None
        else:
            com_ctx["access"] = "non accessible (admin ? non demarre ?)"
    except Exception as e:
        com_ctx["erreur"] = str(e)

    emit({"ok": True, "windows": windows, "com": com_ctx, "note": "valeurs masquees"})
    return 0


DISPATCH = {
    "--detect-form":   cmd_detect_form,
    "--click-insi":    cmd_click_insi,
    "--validate-read": cmd_validate_read,
    "--get-ins":       cmd_get_ins,
    "--diagnostic":    cmd_diagnostic,
}


def main(argv) -> int:
    mode = "--get-ins"  # defaut : enchainement complet (raccourci global)
    for a in argv[1:]:
        if a in DISPATCH:
            mode = a
            break
    return DISPATCH[mode]()


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # filet : toujours rendre un JSON exploitable
        emit({"ok": False, "error": "Erreur inattendue : %s" % e})
        sys.exit(0)
