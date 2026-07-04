const DATA_PATH = "./ielts538_json_enriched/";
const STORE_KEY = "ielts538.orderedTrainer.v1";
const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30];

let words = [];
let todayWords = [];
let currentView = "learn";
let learnIndex = 0;
let reviewIndex = 0;
let quizPlan = [];
let quizIndex = 0;
let quizItem = null;
let selectedLeft = null;
let selectedRight = null;

let state = loadState();

function $(selector) {
  return document.querySelector(selector);
}

function $all(selector) {
  return [...document.querySelectorAll(selector)];
}

function loadState() {
  const fallback = {
    dailyCount: 20,
    groups: {},
    seen: {},
    learned: {},
    review: {},
    mistakes: {},
    quizByDay: {},
    matchedByDay: {},
  };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") };
  } catch {
    return fallback;
  }
}

function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function todayKey() {
  return formatLocalDate(new Date());
}

function addDays(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return formatLocalDate(date);
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hashText(text) {
  return [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function seededRandom(seed) {
  let value = seed || 1;
  return () => {
    value = (value * 9301 + 49297) % 233280;
    return value / 233280;
  };
}

function shuffle(items, random = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function sample(items, random = Math.random) {
  return items[Math.floor(random() * items.length)];
}

async function loadData() {
  words = await fetch(DATA_PATH + "words.json").then((res) => res.json());
  words = words.slice().sort((a, b) => (a.source_rank || a.id) - (b.source_rank || b.id));
  buildTodayWords();
  buildQuizPlan();
}

function ensureTodayGroup() {
  const today = todayKey();
  const count = Number(state.dailyCount || 20);
  if (state.groups[today]) {
    state.groups[today].count = count;
    return state.groups[today];
  }

  const previousGroups = Object.entries(state.groups)
    .filter(([date]) => date < today)
    .sort(([a], [b]) => a.localeCompare(b));
  const latest = previousGroups[previousGroups.length - 1]?.[1];
  const start = latest ? Math.min(words.length, latest.start + latest.count) : 0;
  state.groups[today] = { start, count };
  saveState();
  return state.groups[today];
}

function buildTodayWords() {
  const group = ensureTodayGroup();
  todayWords = words.slice(group.start, Math.min(words.length, group.start + group.count));
  state.matchedByDay[todayKey()] = state.matchedByDay[todayKey()] || {};
  state.quizByDay[todayKey()] = state.quizByDay[todayKey()] || { answered: 0, correct: 0, answeredIds: {} };
}

function learnedPool() {
  const group = ensureTodayGroup();
  const learnedBeforeToday = words.slice(0, group.start);
  const byId = new Map([...learnedBeforeToday, ...todayWords].map((word) => [word.id, word]));
  Object.keys(state.learned || {}).forEach((id) => {
    const word = words.find((item) => String(item.id) === String(id));
    if (word) byId.set(word.id, word);
  });
  return [...byId.values()];
}

function termSet(word) {
  return [...new Set([word.word, word.primary_synonym, ...(word.synonyms || [])].filter(Boolean))];
}

function randomAnswerForPrompt(word, prompt, random = Math.random) {
  const candidates = termSet(word).filter((term) => term !== prompt);
  return sample(candidates.length ? candidates : [word.primary_synonym || word.word], random);
}

function makeQuestion(word, prompt, id, random) {
  const answer = randomAnswerForPrompt(word, prompt, random);
  const pool = learnedPool();
  const distractorTerms = pool
    .filter((item) => item.id !== word.id)
    .flatMap((item) => termSet(item))
    .filter((term) => term && term !== prompt && term !== answer);
  const options = shuffle([answer, ...shuffle([...new Set(distractorTerms)], random).slice(0, 3)], random);
  return { id, wordId: word.id, prompt, answer, options, word };
}

function buildQuizPlan() {
  const today = todayKey();
  const random = seededRandom(hashText(`${today}:quiz:${state.dailyCount}`));
  quizPlan = todayWords.flatMap((word) => [
    makeQuestion(word, word.word, `${today}_${word.id}_word`, random),
    makeQuestion(word, word.primary_synonym, `${today}_${word.id}_primary`, random),
  ]);
  const answered = state.quizByDay[today]?.answered || 0;
  quizIndex = Math.min(answered, Math.max(0, quizPlan.length - 1));
}

function setView(view) {
  currentView = view;
  $all(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  $all(".view").forEach((el) => el.classList.toggle("active", el.id === view));
  if (view === "learn") renderLearn(true);
  if (view === "review") renderReview(true);
  if (view === "quiz") renderQuiz();
  if (view === "match") renderMatch();
  if (view === "mistakes") renderMistakes();
  renderSummary();
}

function renderSummary() {
  const today = todayKey();
  const seenCount = todayWords.filter((word) => state.seen[`${today}_${word.id}`]).length;
  const quiz = state.quizByDay[today] || { answered: 0 };
  const dueCount = dueReviewWords().length;
  $("#summaryWords").textContent = todayWords.length;
  $("#summarySeen").textContent = `${seenCount}/${todayWords.length}`;
  $("#summaryQuiz").textContent = `${Math.min(quiz.answered || 0, quizPlan.length)}/${quizPlan.length}`;
  $("#summaryReview").textContent = dueCount;
  $("#summaryMistakes").textContent = Object.keys(state.mistakes || {}).length;
}

function renderLearn(autoplay = false) {
  const word = todayWords[learnIndex % todayWords.length];
  if (!word) return;
  $("#learnProgress").textContent = `${learnIndex + 1} / ${todayWords.length} · 顺序 ${word.source_rank || word.id}`;
  fillWordCard("", word);
  markLearned(word, "seen");
  if (autoplay) speak(word.word);
}

function fillWordCard(prefix, word) {
  const ids = prefix
    ? {
        title: "#reviewWordTitle",
        meta: "#reviewWordMeta",
        primary: "#reviewPrimarySynonym",
        all: "#reviewAllSynonyms",
      }
    : {
        title: "#wordTitle",
        meta: "#wordMeta",
        primary: "#primarySynonym",
        all: "#allSynonyms",
      };
  $(ids.title).textContent = word.word;
  $(ids.meta).textContent = `Level ${word.level} · ${word.semantic_category} · ${word.part_of_speech.join(", ")}`;
  $(ids.primary).textContent = word.primary_synonym;
  $(ids.all).textContent = word.synonyms.join(" / ");
  if (!prefix) $("#meaningCn").textContent = word.primary_meaning_cn;
}

function markLearned(word, reason) {
  const today = todayKey();
  state.seen[`${today}_${word.id}`] = true;
  state.learned[word.id] = true;
  if (!state.review[word.id]) {
    state.review[word.id] = { stage: 0, due: addDays(today, 1), last: today, reason };
  }
  saveState();
  renderSummary();
}

function speak(text) {
  if (!("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.88;
  window.speechSynthesis.speak(utterance);
}

function dueReviewWords() {
  const today = todayKey();
  return Object.entries(state.review || {})
    .filter(([, record]) => record.due <= today)
    .map(([id]) => words.find((word) => String(word.id) === String(id)))
    .filter(Boolean);
}

function renderReview(autoplay = false) {
  const due = dueReviewWords();
  $("#reviewProgress").textContent = `待复习 ${due.length}`;
  if (!due.length) {
    $("#reviewWordTitle").textContent = "暂无复习";
    $("#reviewWordMeta").textContent = "今天没有到期词。";
    $("#reviewPrimarySynonym").textContent = "";
    $("#reviewAllSynonyms").textContent = "";
    return;
  }
  reviewIndex = reviewIndex % due.length;
  const word = due[reviewIndex];
  fillWordCard("review", word);
  if (autoplay) speak(word.word);
}

function gradeReview(grade) {
  const due = dueReviewWords();
  const word = due[reviewIndex];
  if (!word) return;
  scheduleWord(word.id, grade);
  if (grade !== "good") addMistake("review", word, word.word, word.primary_synonym, "复习反馈不熟");
  saveState();
  renderReview(true);
  renderSummary();
}

function scheduleWord(wordId, grade) {
  const today = todayKey();
  const record = state.review[wordId] || { stage: 0, due: today, last: today };
  if (grade === "good") {
    record.stage = Math.min((record.stage || 0) + 1, REVIEW_INTERVALS.length - 1);
    record.due = addDays(today, REVIEW_INTERVALS[record.stage]);
  } else if (grade === "hard") {
    record.stage = Math.max(0, record.stage || 0);
    record.due = addDays(today, 1);
  } else {
    record.stage = 0;
    record.due = today;
  }
  record.last = today;
  state.review[wordId] = record;
}

function renderQuiz() {
  const today = todayKey();
  const quiz = state.quizByDay[today];
  if ((quiz.answered || 0) >= quizPlan.length) {
    $("#quizProgress").textContent = `已完成 ${quizPlan.length} / ${quizPlan.length}`;
    $("#quizPrompt").textContent = "今日选择题已完成";
    $("#quizOptions").innerHTML = "";
    $("#quizFeedback").className = "feedback hidden";
    return;
  }
  quizIndex = quiz.answered || 0;
  quizItem = quizPlan[quizIndex];
  $("#quizProgress").textContent = `第 ${quizIndex + 1} / ${quizPlan.length} 题`;
  $("#quizPrompt").textContent = quizItem.prompt;
  $("#quizFeedback").className = "feedback hidden";
  $("#quizOptions").innerHTML = quizItem.options.map((option, index) => `
    <button class="option-btn" data-option="${escapeHtml(option)}">
      ${String.fromCharCode(65 + index)}. ${escapeHtml(option)}
    </button>
  `).join("");
  $all("#quizOptions .option-btn").forEach((btn) => {
    btn.addEventListener("click", () => answerQuiz(btn.dataset.option));
  });
  speak(quizItem.prompt);
}

function answerQuiz(chosen) {
  const today = todayKey();
  const quiz = state.quizByDay[today];
  if (quiz.answeredIds[quizItem.id]) return;
  const correct = chosen === quizItem.answer;
  quiz.answeredIds[quizItem.id] = true;
  quiz.answered += 1;
  quiz.correct += correct ? 1 : 0;
  scheduleWord(quizItem.wordId, correct ? "good" : "again");
  if (!correct) addMistake("quiz", quizItem.word, quizItem.prompt, quizItem.answer, `你的答案：${chosen}`);
  saveState();

  $all("#quizOptions .option-btn").forEach((btn) => {
    btn.disabled = true;
    if (btn.dataset.option === quizItem.answer) btn.classList.add("correct");
    if (btn.dataset.option === chosen && !correct) btn.classList.add("wrong");
  });
  const feedback = $("#quizFeedback");
  feedback.className = `feedback ${correct ? "good" : "bad"}`;
  feedback.innerHTML = `
    <strong>${correct ? "答对了" : "答错了"}</strong><br>
    正确答案：${escapeHtml(quizItem.answer)}<br>
    词组：${escapeHtml(quizItem.word.word)} = ${escapeHtml(quizItem.word.primary_synonym)}
  `;
  renderSummary();
}

function renderMatch() {
  selectedLeft = null;
  selectedRight = null;
  $("#matchFeedback").className = "feedback hidden";
  const today = todayKey();
  const matched = state.matchedByDay[today] || {};
  const random = seededRandom(hashText(`${today}:match:${Object.keys(matched).length}`));
  const leftItems = todayWords.map((word) => ({ id: String(word.id), text: word.word }));
  const rightItems = shuffle(todayWords.map((word) => ({ id: String(word.id), text: word.primary_synonym })), random);
  $("#leftWords").innerHTML = leftItems.map((item) => matchButton("left", item, Boolean(matched[item.id]))).join("");
  $("#rightWords").innerHTML = rightItems.map((item) => matchButton("right", item, Boolean(matched[item.id]))).join("");
  $all(".match-btn").forEach((btn) => btn.addEventListener("click", () => selectMatch(btn)));
}

function matchButton(side, item, done) {
  return `
    <button class="match-btn ${done ? "done" : ""}" data-side="${side}" data-id="${item.id}" ${done ? "disabled" : ""}>
      ${escapeHtml(item.text)}
    </button>
  `;
}

function selectMatch(btn) {
  if (btn.disabled) return;
  const side = btn.dataset.side;
  $all(`.match-btn[data-side="${side}"]`).forEach((item) => item.classList.remove("selected"));
  btn.classList.add("selected");
  if (side === "left") selectedLeft = btn;
  if (side === "right") selectedRight = btn;
  if (selectedLeft && selectedRight) checkMatch();
}

function checkMatch() {
  const correct = selectedLeft.dataset.id === selectedRight.dataset.id;
  const feedback = $("#matchFeedback");
  feedback.className = `feedback ${correct ? "good" : "bad"}`;
  const word = words.find((item) => String(item.id) === selectedLeft.dataset.id);
  if (correct) {
    state.matchedByDay[todayKey()][selectedLeft.dataset.id] = true;
    scheduleWord(Number(selectedLeft.dataset.id), "good");
    saveState();
    selectedLeft.classList.add("done");
    selectedRight.classList.add("done");
    selectedLeft.disabled = true;
    selectedRight.disabled = true;
    feedback.textContent = "匹配正确。";
  } else {
    if (word) addMistake("match", word, selectedLeft.textContent.trim(), word.primary_synonym, `误选：${selectedRight.textContent.trim()}`);
    if (word) scheduleWord(word.id, "again");
    saveState();
    feedback.textContent = "不对，已加入错题本和复习。";
  }
  selectedLeft.classList.remove("selected");
  selectedRight.classList.remove("selected");
  selectedLeft = null;
  selectedRight = null;
  renderSummary();
}

function addMistake(type, word, prompt, answer, note) {
  const key = `${type}_${word.id}_${prompt}`;
  const existing = state.mistakes[key] || { count: 0 };
  state.mistakes[key] = {
    type,
    wordId: word.id,
    word: word.word,
    prompt,
    answer,
    primary: word.primary_synonym,
    note,
    count: existing.count + 1,
    lastAt: new Date().toISOString(),
  };
}

function renderMistakes() {
  const items = Object.values(state.mistakes || {}).sort((a, b) => b.count - a.count);
  $("#mistakeList").innerHTML = items.length ? items.map((item) => `
    <div class="mistake-item">
      <strong>${escapeHtml(item.word)} · ${escapeHtml(item.primary)}</strong>
      <span>${escapeHtml(item.type)} · 错 ${item.count} 次</span>
      <p>题目：${escapeHtml(item.prompt)}</p>
      <p>正确答案：${escapeHtml(item.answer)}</p>
      <p>${escapeHtml(item.note || "")}</p>
    </div>
  `).join("") : `<div class="mistake-item"><strong>暂无错题</strong><span>答错后会自动出现在这里。</span></div>`;
}

function resetToday() {
  const today = todayKey();
  state.seen = Object.fromEntries(Object.entries(state.seen || {}).filter(([key]) => !key.startsWith(`${today}_`)));
  state.quizByDay[today] = { answered: 0, correct: 0, answeredIds: {} };
  state.matchedByDay[today] = {};
  learnIndex = 0;
  quizIndex = 0;
  buildTodayWords();
  buildQuizPlan();
  saveState();
  setView(currentView);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

function bindEvents() {
  $("#todayText").textContent = new Date().toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  $("#dailyCount").value = String(state.dailyCount || 20);
  $("#dailyCount").addEventListener("change", (event) => {
    state.dailyCount = Number(event.target.value);
    if (state.groups[todayKey()]) state.groups[todayKey()].count = state.dailyCount;
    buildTodayWords();
    buildQuizPlan();
    saveState();
    setView(currentView);
  });
  $("#resetTodayBtn").addEventListener("click", resetToday);
  $all(".tab").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.view)));
  $("#speakBtn").addEventListener("click", () => speak(todayWords[learnIndex]?.word));
  $("#reviewSpeakBtn").addEventListener("click", () => speak(dueReviewWords()[reviewIndex]?.word));
  $("#prevWord").addEventListener("click", () => {
    learnIndex = (learnIndex - 1 + todayWords.length) % todayWords.length;
    renderLearn(true);
  });
  $("#nextWord").addEventListener("click", () => {
    learnIndex = (learnIndex + 1) % todayWords.length;
    renderLearn(true);
  });
  $all("[data-review-grade]").forEach((btn) => {
    btn.addEventListener("click", () => gradeReview(btn.dataset.reviewGrade));
  });
  $("#nextQuiz").addEventListener("click", renderQuiz);
  $("#newMatch").addEventListener("click", renderMatch);
  $("#clearMistakesBtn").addEventListener("click", () => {
    state.mistakes = {};
    saveState();
    renderMistakes();
    renderSummary();
  });
}

async function init() {
  try {
    registerServiceWorker();
    await loadData();
    bindEvents();
    renderLearn(true);
    renderSummary();
    $("#loading").classList.add("hidden");
  } catch (error) {
    console.error(error);
    $("#loading").textContent = "题库加载失败，请通过本地服务器打开 index.html。";
  }
}

init();

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
}
