// Nintendo Museum 티켓 캘린더에서 지정 날짜가 "○"(예약 가능)로 바뀌었는지 확인하고 ntfy로 알림을 보낸다.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const URL = "https://museum-tickets.nintendo.com/en/calendar";
const TOPIC = process.env.NTFY_TOPIC;
const TARGETS = [
  { tab: "Oct", aria: "October 31, 2026", label: "10/31" },
  { tab: "Nov", aria: "November 1, 2026", label: "11/1" },
];

mkdirSync("debug", { recursive: true });

async function notify(title, message, priority = "default", tags = "ticket") {
  console.log(`[notify] ${title}: ${message}`);
  if (!TOPIC) {
    console.log("NTFY_TOPIC 이 설정되지 않아 알림은 건너뜀");
    return;
  }
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(TOPIC)}`, {
    method: "POST",
    headers: { Title: title, Priority: priority, Tags: tags, Click: URL },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy 전송 실패: ${res.status}`);
}

// FullCalendar 이벤트 영역의 내용(fc- 접두 클래스 제외)으로 상태 판정
function classify(info) {
  const sig = [info.text, ...info.alts, ...info.srcs, ...info.tokens].join(" ").toLowerCase();
  if (!sig.trim()) return "soldout"; // 이벤트 없음 = 표시 없음
  if (/[×✕✖╳]|closed|holiday|close\b/.test(sig)) return "closed";
  if (/[—–−－ー]|(^|\s)-(\s|$)|sold|dash|minus|none|\bng\b|full|unavail/.test(sig)) return "soldout";
  if (/[○◯〇]|avail|vacan|circle|\bok\b|\bopen\b|stock|reserve/.test(sig)) return "available";
  return "unknown";
}

async function readDay(page, aria) {
  return page.evaluate((aria) => {
    const a = document.querySelector(`a[aria-label="${aria}"]`);
    if (!a) return null;
    const cell = a.closest("td") || a.parentElement;
    const ev = cell.querySelector(".fc-daygrid-day-events") || cell;
    const els = [...ev.querySelectorAll("*")];
    const tokens = els
      .flatMap((e) => String(e.className?.baseVal ?? e.className ?? "").split(/\s+/))
      .filter((c) => c && !c.startsWith("fc-"));
    return {
      text: ev.innerText.trim(),
      alts: [...ev.querySelectorAll("img")].map((i) => i.alt || ""),
      srcs: [...ev.querySelectorAll("img")].map((i) => i.src.split("/").pop()),
      tokens: [...new Set(tokens)],
      hasHref: !!ev.querySelector("a[href]"),
      html: ev.innerHTML.slice(0, 600),
    };
  }, aria);
}

async function gotoMonth(page, t) {
  const sel = `a[aria-label="${t.aria}"]`;
  if (await page.locator(sel).count()) return;
  const strategies = [
    () => page.getByText(new RegExp(`^\\s*${t.tab}\\b`)).first().click(),
    () =>
      page
        .locator("button, a, li, div[role=tab]")
        .filter({ hasText: new RegExp(`^\\s*${t.tab}\\b`) })
        .last()
        .click(),
  ];
  for (const click of strategies) {
    try {
      await click();
      await page.waitForSelector(sel, { timeout: 15000 });
      return;
    } catch {}
  }
  const labels = await page.$$eval("a.fc-daygrid-day-number", (as) => as.slice(0, 3).map((a) => a.getAttribute("aria-label")));
  throw new Error(`${t.tab} 탭 전환 실패. 현재 표시 중인 날짜 예: ${labels.join(" | ")}`);
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ locale: "en-US", viewport: { width: 430, height: 1200 } })).newPage();
let failed = false;

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
  const alerts = [];

  for (const t of TARGETS) {
    await gotoMonth(page, t);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `debug/${t.tab}.png`, fullPage: true });
    writeFileSync(`debug/${t.tab}.html`, await page.content());

    const info = await readDay(page, t.aria);
    if (!info) throw new Error(`${t.aria} 셀을 찾지 못함 (debug/ 확인)`);
    const status = classify(info);
    console.log(`${t.label} [${t.aria}] => ${status}`);
    console.log(`  tokens=${JSON.stringify(info.tokens)} text=${JSON.stringify(info.text)} alts=${JSON.stringify(info.alts)} href=${info.hasHref}`);
    console.log(`  html=${info.html}`);
    if (status === "available") alerts.push(`${t.label} 예약 가능!`);
    else if (status === "unknown") alerts.push(`${t.label} 상태 변화 감지(확인 필요): ${info.text.replace(/\s+/g, " ") || info.tokens.join(",")}`);
  }

  if (process.env.TEST_NOTIFY === "true") await notify("Nintendo Museum test", "테스트 알림입니다");
  if (alerts.length) await notify("Nintendo Museum ticket!", alerts.join("\n"), "urgent", "tada,ticket");
} catch (e) {
  failed = true;
  console.error(e);
  await page.screenshot({ path: "debug/error.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
