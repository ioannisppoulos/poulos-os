#!/usr/bin/env python3
"""Synthetic browser regression. Blocks production requests and writes."""
import argparse
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
WS_A = "11111111-1111-4111-8111-111111111111"
WS_B = "22222222-2222-4222-8222-222222222222"
TASK_A = "aaaaaaaa-1111-4111-8111-111111111111"
EVENT_A = "eeeeeeee-1111-4111-8111-111111111111"
parser = argparse.ArgumentParser()
parser.add_argument("--base-url", default="http://127.0.0.1:5174")
args = parser.parse_args()
BASE_URL = args.base_url.rstrip("/")
BASE = urlparse(BASE_URL)
source = (ROOT / "data.js").read_text()
handoff = re.search(r"export function getHandoff\(task\) \{.*?\n\}", source, re.S)
if not handoff:
    raise RuntimeError("Cannot locate the actual getHandoff function in data.js")
MOCK = (ROOT / "tests/mock-data.js").read_text().replace("/*ACTUAL_HANDOFF*/", handoff.group(0))
results = []

def load(page):
    page.goto(BASE_URL, wait_until="networkidle")
    expect(page.locator("#sign-in-form")).to_be_visible()

def login(page):
    load(page)
    page.locator('#sign-in-form [name="email"]').fill("synthetic@example.test")
    page.locator('#sign-in-form [name="password"]').fill("synthetic-password")
    page.locator('#sign-in-form [type="submit"]').click()
    expect(page.locator("#workstation")).to_be_visible()
    expect(page.locator("#view-content")).to_have_attribute("aria-busy", "false")

def navigate(page, view):
    if page.viewport_size["width"] < 800:
        page.locator("#open-nav").click()
    page.locator(f'#main-nav [data-view="{view}"]').click()
    expect(page.locator(f'#main-nav [data-view="{view}"]')).to_have_attribute("aria-current", "page")

def scope(page, ws):
    page.locator(f'#scope-bar [data-scope="{ws}"]').click()
    expect(page.locator(f'#scope-bar [data-scope="{ws}"]')).to_have_attribute("aria-pressed", "true")

def submit_task(page):
    page.locator('#task-form [type="submit"]').click()

def dialog_closed(page, dialog):
    expect(page.locator(dialog)).not_to_be_visible()

def assert_no_xss(page):
    assert page.evaluate("window.__xss === undefined"), "Injected script executed"
    assert page.locator("#view-content [onerror], #view-content [onload]").count() == 0, "Unsafe inline event handler rendered"
    assert page.locator('#view-content a[href^="javascript:"]').count() == 0, "Unsafe JavaScript URL rendered"

def auth_errors(page):
    load(page)
    page.locator('#sign-in-form [name="email"]').fill("synthetic@example.test")
    page.locator('#sign-in-form [name="password"]').fill("incorrect")
    page.locator('#sign-in-form [type="submit"]').click()
    expect(page.locator("#sign-in-error")).to_contain_text("Synthetic invalid login")
    expect(page.locator('#sign-in-form [type="submit"]')).to_be_enabled()
    expect(page.locator("#workstation")).not_to_be_visible()
    assert page.evaluate("window.__mock.calls.filter(c=>c.name==='loadDashboard').length") == 0
    page.locator('#sign-in-form [name="password"]').fill("synthetic-password")
    page.locator('#sign-in-form [type="submit"]').click()
    expect(page.locator("#workstation")).to_be_visible()
    page.locator("#logout").click()
    expect(page.locator("#sign-in-form")).to_be_visible()
    assert page.evaluate("window.__mock.calls.some(c=>c.name==='signOut')")

def task_lifecycle(page):
    login(page)
    scope(page, WS_A)
    navigate(page, "tasks")
    page.locator("#new-task").click()
    expect(page.locator('#task-form [name="workspace_id"]')).to_have_value(WS_A)
    page.locator('#task-form [name="title"]').fill("Synthetic created task")
    page.locator('#task-form [name="notes"]').fill("Synthetic task notes")
    page.locator('#task-form [name="assignee"]').select_option("claude")
    page.locator('#task-form [name="priority"]').select_option("2")
    page.locator('#task-form [name="status"]').select_option("doing")
    submit_task(page)
    dialog_closed(page, "#task-dialog")
    task = page.evaluate("window.__mock.data.tasks.find(t=>t.title==='Synthetic created task')")
    assert task["workspace_id"] == WS_A and task["assignee"] == "claude" and task["status"] == "doing"
    task_id = task["id"]
    page.locator(f'[data-action="edit-task"][data-id="{task_id}"]').click()
    expect(page.locator('#task-form [name="workspace_id"]')).to_be_disabled()
    page.locator('#task-form [name="title"]').fill("Synthetic edited task")
    page.locator('#task-form [name="assignee"]').select_option("codex")
    page.locator('#task-form [name="notes"]').fill("Synthetic edited context")
    submit_task(page)
    dialog_closed(page, "#task-dialog")
    task = page.evaluate("(id)=>window.__mock.data.tasks.find(t=>t.id===id)", task_id)
    assert task["version"] == 2 and task["assignee"] == "codex" and task["notes"] == "Synthetic edited context"
    page.locator(f'[data-action="toggle-task"][data-id="{task_id}"]').click()
    expect(page.locator(f'[data-task="{task_id}"]')).to_have_count(0)
    page.locator("#task-status-filter").select_option("done")
    expect(page.locator(f'[data-task="{task_id}"]')).to_be_visible()
    task = page.evaluate("(id)=>window.__mock.data.tasks.find(t=>t.id===id)", task_id)
    assert task["status"] == "done" and task["version"] == 3 and task["completed_at"]

def conflict_preserves_draft(page):
    login(page)
    scope(page, WS_A)
    navigate(page, "tasks")
    page.locator(f'[data-action="edit-task"][data-id="{TASK_A}"]').click()
    page.locator('#task-form [name="title"]').fill("UNSAVED_SYNTHETIC_DRAFT")
    page.locator('#task-form [name="notes"]').fill("UNSAVED_SYNTHETIC_NOTES")
    page.locator('#task-form [name="assignee"]').select_option("claude")
    before=page.evaluate("window.__mock.calls.filter(c=>c.name==='loadDashboard').length")
    page.evaluate("(id)=>{const task=window.__mock.data.tasks.find(t=>t.id===id);task.version=2;task.title='SYNTHETIC_REMOTE_CHANGE';window.__mock.refresh()}",TASK_A)
    page.wait_for_function("(before)=>window.__mock.calls.filter(c=>c.name==='loadDashboard').length>before",arg=before)
    expect(page.locator('#task-form [name="title"]')).to_have_value("UNSAVED_SYNTHETIC_DRAFT")
    submit_task(page)
    expect(page.locator("#task-form-error")).to_contain_text("άλλαξε από άλλη συνεδρία")
    expect(page.locator('#task-form [name="title"]')).to_have_value("UNSAVED_SYNTHETIC_DRAFT")
    expect(page.locator('#task-form [name="notes"]')).to_have_value("UNSAVED_SYNTHETIC_NOTES")
    expect(page.locator('#task-form [name="assignee"]')).to_have_value("claude")
    expect(page.locator('#task-form [type="submit"]')).to_be_enabled()
    assert page.evaluate("(id)=>window.__mock.data.tasks.find(t=>t.id===id).title",TASK_A) == "SYNTHETIC_REMOTE_CHANGE"
    assert page.evaluate("window.__mock.calls.filter(c=>c.name==='updateTask').at(-1).value.version") == 1
    before=page.evaluate("window.__mock.calls.filter(c=>c.name==='loadDashboard').length")
    page.evaluate("window.__mock.refresh()")
    page.wait_for_function("(before)=>window.__mock.calls.filter(c=>c.name==='loadDashboard').length>before",arg=before)
    expect(page.locator('#task-form [name="title"]')).to_have_value("UNSAVED_SYNTHETIC_DRAFT")
    expect(page.locator('#task-form [name="notes"]')).to_have_value("UNSAVED_SYNTHETIC_NOTES")

def workspace_isolation(page):
    login(page)
    scope(page, WS_A)
    navigate(page, "tasks")
    expect(page.locator("#view-content")).not_to_contain_text("BETA_PRIVATE")
    expect(page.locator("#view-content")).to_contain_text("Synthetic Alpha priority")
    page.locator("#task-assignee-filter").select_option("claude")
    expect(page.locator("#view-content [data-task]")).to_have_count(0)
    page.locator("#task-assignee-filter").select_option("all")
    page.locator("#global-search").fill("BETA_PRIVATE")
    expect(page.locator("#view-content [data-task]")).to_have_count(0)
    page.locator("#global-search").fill("")
    for view in ["inbox","connections","agents","today"]:
        navigate(page,view)
        expect(page.locator("#view-content")).not_to_contain_text("BETA_PRIVATE")
    scope(page,WS_B)
    navigate(page,"tasks")
    expect(page.locator("#view-content")).to_contain_text("BETA_PRIVATE_MARKER")
    expect(page.locator("#view-content")).not_to_contain_text("Synthetic Alpha priority")
    assert_no_xss(page)

def incoming_triage(page):
    login(page)
    scope(page, WS_A)
    navigate(page, "inbox")
    assert_no_xss(page)
    row=page.locator(".inbox-row").filter(has_text="Synthetic incoming")
    expect(row).to_be_visible()
    row.locator('[data-action="triage"]').filter(has_text="Διαβάστηκε").click()
    page.wait_for_function("(id)=>window.__mock.data.events.find(e=>e.id===id).status==='triaged'",arg=EVENT_A,timeout=3000)
    expect(page.locator(".inbox-row").filter(has_text="Synthetic incoming")).to_have_count(0)
    page.locator("#inbox-status-filter").select_option("triaged")
    row=page.locator(".inbox-row").filter(has_text="Synthetic incoming")
    expect(row).to_be_visible()
    row.locator('[data-action="triage"][data-status="archived"]').click()
    page.wait_for_function("(id)=>window.__mock.data.events.find(e=>e.id===id).status==='archived'",arg=EVENT_A,timeout=3000)
    call=page.evaluate("window.__mock.calls.filter(c=>c.name==='triageEvent').at(-1)")
    assert call["value"] == {"id":EVENT_A,"status":"archived"}
    assert_no_xss(page)

def connections_registration_truth(page):
    login(page)
    scope(page, WS_A)
    navigate(page, "connections")
    mail=page.locator(".connection-row").filter(has_text="Synthetic Mail")
    expect(mail.locator(".agent-col")).to_contain_text("Επιβεβαιωμένη πρόσβαση")
    expect(mail.locator(".sync-col")).to_contain_text("Δεν έχει ρυθμιστεί")
    expect(mail).not_to_contain_text("Ενεργή ροή")
    notes=page.locator(".connection-row").filter(has_text="Synthetic Notes")
    expect(notes.locator(".sync-col")).to_contain_text("Στιγμιότυπο")
    reauth=page.locator(".connection-row").filter(has_text="Synthetic Reauth App")
    expect(reauth.locator(".agent-col")).to_contain_text("επανασύνδεση")
    expect(reauth.locator(".sync-col")).to_contain_text("Σφάλμα συγχρονισμού")
    expect(page.locator(".app-summary")).to_contain_text("0 με ενεργή ροή")
    page.locator('[data-action="new-connection"]').first.click()
    page.locator('#connection-form [name="provider"]').select_option("other")
    page.locator('#connection-form [name="label"]').fill("Synthetic New App")
    page.locator('#connection-form [name="url"]').fill("https://example.test/new-app")
    page.locator('#connection-form [type="submit"]').click()
    dialog_closed(page,"#connection-dialog")
    new=page.locator(".connection-row").filter(has_text="Synthetic New App")
    expect(new).to_be_visible()
    expect(new.locator(".agent-col")).to_contain_text("Χρειάζεται επιβεβαίωση")
    expect(new.locator(".sync-col")).to_contain_text("Δεν έχει ρυθμιστεί")
    saved=page.evaluate("window.__mock.calls.find(c=>c.name==='saveConnection').value")
    assert saved["workspace_id"] == WS_A and saved["url"] == "https://example.test/new-app"
    assert not any(key in saved for key in ("agent_status","sync_status","verified_at"))
    expect(page.locator("#view-content")).not_to_contain_text("BETA_PRIVATE_APP")

def handoff_escape_logout(page):
    login(page)
    scope(page, WS_A)
    navigate(page, "tasks")
    expect(page.locator("#view-content")).to_contain_text('<img src=x onerror="window.__xss=1">')
    assert_no_xss(page)
    page.locator(f'[data-action="handoff"][data-id="{TASK_A}"]').click()
    packet=page.locator("#handoff-packet").inner_text()
    assert "Synthetic Alpha priority" in packet and "ALPHA_ONLY_CONTEXT" in packet and WS_A in packet
    assert "BETA_PRIVATE" not in packet and "BETA_SECRET" not in packet and WS_B not in packet
    page.locator('[data-action="copy-handoff"]').click()
    page.wait_for_function("typeof window.__clipboard==='string'")
    assert page.evaluate("window.__clipboard") == packet
    page.evaluate("window.__mock.expireSession()")
    expect(page.locator("#sign-in-form")).to_be_visible()
    expect(page.locator("dialog[open]")).to_have_count(0)
    expect(page.locator("#handoff-dialog-content")).to_be_empty()

def mobile_navigation(page):
    login(page)
    scope(page,WS_A)
    for view in ["today","tasks","inbox","connections","agents"]:
        navigate(page,view)
        expect(page.locator("#open-nav")).to_have_attribute("aria-expanded","false")
        expect(page.locator("#nav-overlay")).not_to_be_visible()
        widths=page.evaluate("({viewport:window.innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth})")
        assert max(widths["html"],widths["body"]) <= widths["viewport"] + 1, f"Horizontal overflow in {view}: {widths}"
    page.locator("#new-task").click()
    expect(page.locator("#task-dialog")).to_be_visible()
    widths=page.evaluate("({viewport:window.innerWidth,right:document.querySelector('#task-dialog').getBoundingClientRect().right,left:document.querySelector('#task-dialog').getBoundingClientRect().left})")
    assert widths["left"] >= 0 and widths["right"] <= widths["viewport"] + 1, f"Mobile task dialog outside viewport: {widths}"
    page.locator('#task-dialog [data-close="task-dialog"]').first.click()
    dialog_closed(page,"#task-dialog")
    page.locator("#open-nav").click()
    expect(page.locator("#nav-overlay")).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.locator("#nav-overlay")).not_to_be_visible()

SCENARIOS = [
    ("auth_errors_and_logout",auth_errors,1440),
    ("task_create_edit_complete_assignee",task_lifecycle,1440),
    ("version_conflict_preserves_draft",conflict_preserves_draft,1440),
    ("workspace_isolation_and_filters",workspace_isolation,1440),
    ("incoming_triage",incoming_triage,1440),
    ("connection_registration_and_truthful_status",connections_registration_truth,1440),
    ("scoped_handoff_escaping_logout_cleanup",handoff_escape_logout,1440),
    ("mobile_390_navigation_no_overflow",mobile_navigation,390),
]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        for name,test,width in SCENARIOS:
            context=browser.new_context(viewport={"width":width,"height":900},locale="el-GR",timezone_id="Europe/Athens")
            context.add_init_script("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__clipboard=String(text)}}});")
            blocked=[]
            def route_request(route):
                url=urlparse(route.request.url)
                if url.path=="/data.js":
                    return route.fulfill(status=200,content_type="text/javascript; charset=utf-8",body=MOCK)
                if url.scheme==BASE.scheme and url.netloc==BASE.netloc:
                    return route.continue_()
                blocked.append(route.request.url)
                return route.abort()
            context.route("**/*",route_request)
            page=context.new_page()
            page.set_default_timeout(5000)
            page_errors=[]
            page.on("pageerror",lambda error:page_errors.append(str(error)))
            started=time.monotonic()
            try:
                test(page)
                assert not page_errors, f"Browser errors: {page_errors}"
                result={"name":name,"status":"passed","seconds":round(time.monotonic()-started,2)}
            except Exception as error:
                artifacts=ROOT/"tests"/"artifacts"
                artifacts.mkdir(exist_ok=True)
                page.screenshot(path=str(artifacts/f"{name}.png"),full_page=True)
                result={"name":name,"status":"failed","error":str(error),"page_errors":page_errors,"seconds":round(time.monotonic()-started,2)}
            results.append(result)
            print(json.dumps(result,ensure_ascii=False),flush=True)
            context.close()
    finally:
        browser.close()
report={"synthetic_only":True,"production_network_blocked":True,"results":results,"passed":sum(r["status"]=="passed" for r in results),"total":len(results)}
(ROOT/"tests"/"results.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"passed":report["passed"],"total":report["total"]}),flush=True)
raise SystemExit(0 if report["passed"]==report["total"] else 1)
