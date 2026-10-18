// Nintendo Museum 티켓 캘린더에서 지정 날짜가 "○"(예약 가능)로 바뀌었는지 확인하고 ntfy로 알림을 보낸다.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const URL = "https://museum-tickets.nintendo.com/en/calendar";
const TOPIC = process.env.NTFY_TOPIC;
const TARGETS = [
  { tab: "Oct", day: 31, label: "10/31" },
  { tab: "Nov", day: 1, label: "11/1" },
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

// 셀 내용을 보고 상태 판정
function classify(info) {
  const sig = [info.rest, ...info.alts, ...info.srcs, ...info.classes].join(" ").toLowerCase();
  if (/[×✕✖╳]|closed|holiday|close\b/.test(sig)) return "closed";
  if (/[—–−－ー]|(^|\s)-(\s|$)|sold|dash|minus|none|\bng\b/.test(sig)) return "soldout";
  if (/[○◯〇]|avail|vacan|circle|\bok\b|\bopen\b/.test(sig)) return "available";
  return "unknown";
}

async function readDay(page, day) {
  return page.evaluate((day) => {
    let cells = [...document.querySelectorAll("td")];
    if (!cells.length) cells = [...document.querySelectorAll("[role=gridcell], li")];
    const hits = cells.filter(
      (c) => (c.innerText || "").trim().split(/\s+/)[0] === String(day),
    );
    if (!hits.length) return null;
    // 이전/다음 달의 흐린 날짜와 겹칠 수 있어서: 1~7일은 첫 번째, 그 외는 마지막 셀이 해당 월
    const cell = day <= 7 ? hits[0] : hits[hits.length - 1];
    const text = cell.innerText.trim();
    return {
      text,
      rest: text.split(/\s+/).slice(1).join(" "),
      alts: [...cell.querySelectorAll("img")].map((i) => i.alt || ""),
      srcs: [...cell.querySelectorAll("img")].map((i) => i.src.split("/").pop()),
      classes: [cell, ...cell.querySelectorAll("*")].map((e) => e.className?.baseVal ?? e.className ?? "").filter(Boolean),
      html: cell.innerHTML.slice(0, 500),
    };
  }, day);
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ locale: "en-US", viewport: { width: 430, height: 1200 } })).newPage();
let failed = false;

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
  const alerts = [];

  for (const t of TARGETS) {
    await page
      .locator("button, a, li, div[role=tab]")
      .filter({ hasText: new RegExp(`^\\s*${t.tab}\\b`) })
      .last()
      .click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `debug/${t.tab}.png`, fullPage: true });
    writeFileSync(`debug/${t.tab}.html`, await page.content());

    const info = await readDay(page, t.day);
    if (!info) throw new Error(`${t.tab} 탭에서 ${t.day}일 셀을 찾지 못함 (debug/ 확인)`);
    const status = classify(info);
    console.log(`${t.label}: ${status}`, JSON.stringify(info));
    if (status === "available") alerts.push(`${t.label} 예약 가능!`);
    else if (status === "unknown") alerts.push(`${t.label} 상태 변화 감지(확인 필요): ${info.text.replace(/\s+/g, " ")}`);
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
