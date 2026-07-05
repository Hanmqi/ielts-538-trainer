const DATA_PATH = "./ielts538_json_enriched/";
const STORE_KEY = "ielts538.orderedTrainer.v2";
const LEGACY_STORE_KEY = "ielts538.orderedTrainer.v1";
const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30];

let words = [];
let sentenceSeeds = [];
let todayWords = [];
let currentView = "home";
let learnIndex = 0;
let reviewIndex = 0;
let quizPlan = [];
let quizItem = null;
let quizSession = "daily";
let mistakeQuizState = { answered: 0, correct: 0, answeredIds: {} };
let sentenceItem = null;
let selectedLeft = null;
let selectedRight = null;
let deferredInstallPrompt = null;

let state = loadState();

function $(selector) {
  return document.querySelector(selector);
}

function $all(selector) {
  return [...document.querySelectorAll(selector)];
}

function defaultState() {
  return {
    dailyCount: 20,
    groups: {},
    seen: {},
    learned: {},
    mastered: {},
    review: {},
    mistakes: {},
    quizByDay: {},
    sentenceByDay: {},
    matchedByDay: {},
    stats: {
      answered: 0,
      correct: 0,
      byCategory: {},
      byDay: {},
    },
  };
}

function loadState() {
  const fallback = defaultState();
  try {
    const raw = localStorage.getItem(STORE_KEY) || localStorage.getItem(LEGACY_STORE_KEY) || "{}";
    return normalizeState({ ...fallback, ...JSON.parse(raw) });
  } catch {
    return fallback;
  }
}

function normalizeState(value) {
  const next = { ...defaultState(), ...value };
  next.groups ||= {};
  next.seen ||= {};
  next.learned ||= {};
  next.mastered ||= {};
  next.review ||= {};
  next.mistakes ||= {};
  next.quizByDay ||= {};
  next.sentenceByDay ||= {};
  next.matchedByDay ||= {};
  next.stats ||= {};
  next.stats.answered ||= 0;
  next.stats.correct ||= 0;
  next.stats.byCategory ||= {};
  next.stats.byDay ||= {};
  return next;
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
  const [wordData, seedData] = await Promise.all([
    fetch(DATA_PATH + "words.json").then((res) => res.json()),
    fetch(DATA_PATH + "sentence_pair_seeds.json").then((res) => (res.ok ? res.json() : [])),
  ]);
  words = wordData.slice().sort((a, b) => (a.source_rank || a.id) - (b.source_rank || b.id));
  sentenceSeeds = Array.isArray(seedData) ? seedData : [];
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
  state.matchedByDay[todayKey()] ||= {};
  state.quizByDay[todayKey()] ||= { answered: 0, correct: 0, answeredIds: {} };
  state.sentenceByDay[todayKey()] ||= { answered: 0, correct: 0 };
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

function makeQuestion(word, prompt, id, random, source = "daily") {
  const answer = randomAnswerForPrompt(word, prompt, random);
  const pool = learnedPool();
  const distractorTerms = pool
    .filter((item) => item.id !== word.id)
    .flatMap((item) => termSet(item))
    .filter((term) => term && term !== prompt && term !== answer);
  const options = shuffle([answer, ...shuffle([...new Set(distractorTerms)], random).slice(0, 3)], random);
  return { id, wordId: word.id, prompt, answer, options, word, source };
}

function buildQuizPlan() {
  const today = todayKey();
  const random = seededRandom(hashText(`${today}:quiz:${state.dailyCount}`));
  quizPlan = todayWords.flatMap((word) => [
    makeQuestion(word, word.word, `${today}_${word.id}_word`, random),
    makeQuestion(word, word.primary_synonym, `${today}_${word.id}_primary`, random),
  ]);
}

function setView(view) {
  currentView = view;
  $all(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  $all(".view").forEach((el) => el.classList.toggle("active", el.id === view));
  if (view === "home") renderHome();
  if (view === "learn") renderLearn(true);
  if (view === "review") renderReview(true);
  if (view === "quiz") {
    if (quizSession !== "mistake") {
      quizSession = "daily";
      buildQuizPlan();
    }
    renderQuiz();
  }
  if (view === "match") renderMatch();
  if (view === "sentence") renderSentence();
  if (view === "mistakes") renderMistakes();
  if (view === "stats") renderStats();
  renderSummary();
}

function renderSummary() {
  const today = todayKey();
  const seenCount = todayWords.filter((word) => state.seen[`${today}_${word.id}`]).length;
  const quiz = state.quizByDay[today] || { answered: 0 };
  $("#summaryWords").textContent = todayWords.length;
  $("#summarySeen").textContent = `${seenCount}/${todayWords.length}`;
  $("#summaryQuiz").textContent = `${Math.min(quiz.answered || 0, quizPlan.length)}/${quizPlan.length}`;
  $("#summaryReview").textContent = dueReviewWords().length;
  $("#summaryMistakes").textContent = Object.keys(state.mistakes || {}).length;
  if (currentView === "home") renderHome();
}

function dailyStatus() {
  const today = todayKey();
  const seen = todayWords.filter((word) => state.seen[`${today}_${word.id}`]).length;
  const quiz = state.quizByDay[today] || { answered: 0, correct: 0 };
  const matched = Object.keys(state.matchedByDay[today] || {}).length;
  const sentence = state.sentenceByDay[today] || { answered: 0, correct: 0 };
  const reviewDue = dueReviewWords().length;
  return { today, seen, quiz, matched, sentence, reviewDue };
}

function renderHome() {
  const status = dailyStatus();
  const tasks = [
    { key: "review", title: "复习到期词", done: status.reviewDue === 0, value: status.reviewDue ? `${status.reviewDue} 个待复习` : "已完成" },
    { key: "learn", title: "学习今日新词", done: status.seen >= todayWords.length, value: `${status.seen}/${todayWords.length}` },
    { key: "quiz", title: "完成选择题", done: status.quiz.answered >= quizPlan.length, value: `${status.quiz.answered}/${quizPlan.length}` },
    { key: "match", title: "完成连线题", done: status.matched >= todayWords.length, value: `${status.matched}/${todayWords.length}` },
    { key: "sentence", title: "句子识别训练", done: status.sentence.answered >= Math.min(10, todayWords.length), value: `${status.sentence.answered}/${Math.min(10, todayWords.length)}` },
  ];
  $("#pathList").innerHTML = tasks.map((task) => `
    <button class="path-item ${task.done ? "done" : ""}" data-jump="${task.key}">
      <strong>${task.title}</strong>
      <span>${task.value}</span>
    </button>
  `).join("");
  $all("#pathList [data-jump]").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.jump)));

  const complete = tasks.every((task) => task.done);
  const accuracy = status.quiz.answered ? Math.round((status.quiz.correct / status.quiz.answered) * 100) : 0;
  const top = topMistakes(3).map((item) => `${item.word}(${item.count})`).join(" / ") || "暂无";
  $("#finishReport").innerHTML = `
    <div class="report-line"><span>完成状态</span><strong>${complete ? "今日已完成" : "继续加油"}</strong></div>
    <div class="report-line"><span>选择题正确率</span><strong>${accuracy}%</strong></div>
    <div class="report-line"><span>明日复习预计</span><strong>${reviewDueOn(addDays(todayKey(), 1)).length}</strong></div>
    <div class="report-line"><span>最容易错</span><strong>${escapeHtml(top)}</strong></div>
  `;
}

function nextTaskView() {
  const status = dailyStatus();
  if (status.reviewDue > 0) return "review";
  if (status.seen < todayWords.length) return "learn";
  if (status.quiz.answered < quizPlan.length) return "quiz";
  if (status.matched < todayWords.length) return "match";
  if (status.sentence.answered < Math.min(10, todayWords.length)) return "sentence";
  return "stats";
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
    ? { title: "#reviewWordTitle", meta: "#reviewWordMeta", primary: "#reviewPrimarySynonym", all: "#reviewAllSynonyms" }
    : { title: "#wordTitle", meta: "#wordMeta", primary: "#primarySynonym", all: "#allSynonyms" };
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

function reviewDueOn(dateKey) {
  return Object.entries(state.review || {})
    .filter(([, record]) => record.due === dateKey)
    .map(([id]) => words.find((word) => String(word.id) === String(id)))
    .filter(Boolean);
}

function renderReview(autoplay = false) {
  const due = dueReviewWords();
  $("#reviewProgress").textContent = `待复习 ${due.length}`;
  renderReviewQueue();
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

function renderReviewQueue() {
  const today = todayKey();
  const rows = [
    ["今天", dueReviewWords().length],
    ["明天", reviewDueOn(addDays(today, 1)).length],
    ["7 天内", Object.values(state.review || {}).filter((item) => item.due > today && item.due <= addDays(today, 7)).length],
    ["全部计划", Object.keys(state.review || {}).length],
  ];
  $("#reviewQueue").innerHTML = rows.map(([label, value]) => `
    <div class="queue-row"><span>${label}</span><strong>${value}</strong></div>
  `).join("");
}

function gradeReview(grade) {
  const due = dueReviewWords();
  const word = due[reviewIndex];
  if (!word) return;
  scheduleWord(word.id, grade);
  if (grade !== "good") addMistake("review", word, word.word, word.primary_synonym, "复习反馈不熟");
  if (grade === "good" && (state.review[word.id]?.stage || 0) >= 3) state.mastered[word.id] = true;
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
  const quiz = quizSession === "mistake" ? mistakeQuizState : state.quizByDay[today];
  if ((quiz.answered || 0) >= quizPlan.length) {
    $("#quizProgress").textContent = `已完成 ${quizPlan.length} / ${quizPlan.length}`;
    $("#quizPrompt").textContent = "今日选择题已完成";
    $("#quizOptions").innerHTML = "";
    $("#quizFeedback").className = "feedback hidden";
    return;
  }
  quizItem = quizPlan[quiz.answered || 0];
  drawQuestion(quizItem, "#quizOptions", answerQuiz);
  $("#quizProgress").textContent = `第 ${(quiz.answered || 0) + 1} / ${quizPlan.length} 题`;
  $("#quizPrompt").textContent = quizItem.prompt;
  $("#quizFeedback").className = "feedback hidden";
  speak(quizItem.prompt);
}

function drawQuestion(question, container, handler) {
  $(container).innerHTML = question.options.map((option, index) => `
    <button class="option-btn" data-option="${escapeHtml(option)}">
      ${String.fromCharCode(65 + index)}. ${escapeHtml(option)}
    </button>
  `).join("");
  $all(`${container} .option-btn`).forEach((btn) => btn.addEventListener("click", () => handler(btn.dataset.option)));
}

function answerQuiz(chosen) {
  const today = todayKey();
  const quiz = quizSession === "mistake" ? mistakeQuizState : state.quizByDay[today];
  if (quiz.answeredIds[quizItem.id]) return;
  const correct = chosen === quizItem.answer;
  quiz.answeredIds[quizItem.id] = true;
  quiz.answered += 1;
  quiz.correct += correct ? 1 : 0;
  recordAnswer(quizItem.word, correct);
  scheduleWord(quizItem.wordId, correct ? "good" : "again");
  if (!correct) addMistake("quiz", quizItem.word, quizItem.prompt, quizItem.answer, `你的答案：${chosen}`);
  if (correct && quizSession === "mistake") {
    removeMistakesForWord(quizItem.wordId);
  }
  saveState();
  markOptions("#quizOptions", chosen, quizItem.answer);
  showQuestionFeedback("#quizFeedback", correct, chosen, quizItem.answer, quizItem.word);
  renderSummary();
}

function markOptions(container, chosen, answer) {
  $all(`${container} .option-btn`).forEach((btn) => {
    btn.disabled = true;
    if (btn.dataset.option === answer) btn.classList.add("correct");
    if (btn.dataset.option === chosen && chosen !== answer) btn.classList.add("wrong");
  });
}

function showQuestionFeedback(target, correct, chosen, answer, word) {
  const selectedWord = findWordByTerm(chosen);
  const wrongHint = !correct && selectedWord
    ? `<br>你选的「${escapeHtml(chosen)}」更接近：${escapeHtml(selectedWord.word)} = ${escapeHtml(selectedWord.primary_synonym)}`
    : "";
  $(target).className = `feedback ${correct ? "good" : "bad"}`;
  $(target).innerHTML = `
    <strong>${correct ? "答对了" : "答错了"}</strong><br>
    正确答案：${escapeHtml(answer)}<br>
    词组：${escapeHtml(word.word)} = ${escapeHtml(word.primary_synonym)}<br>
    其他替换：${escapeHtml(word.synonyms.join(" / "))}<br>
    中文辅助：${escapeHtml(word.primary_meaning_cn || "")}
    ${wrongHint}
  `;
}

function findWordByTerm(term) {
  return words.find((word) => termSet(word).includes(term));
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
    if (word) recordAnswer(word, true);
    saveState();
    selectedLeft.classList.add("done");
    selectedRight.classList.add("done");
    selectedLeft.disabled = true;
    selectedRight.disabled = true;
    feedback.textContent = "匹配正确。";
  } else {
    if (word) {
      addMistake("match", word, selectedLeft.textContent.trim(), word.primary_synonym, `误选：${selectedRight.textContent.trim()}`);
      scheduleWord(word.id, "again");
      recordAnswer(word, false);
    }
    saveState();
    feedback.textContent = "不对，已加入错题本和复习。";
  }
  selectedLeft.classList.remove("selected");
  selectedRight.classList.remove("selected");
  selectedLeft = null;
  selectedRight = null;
  renderSummary();
}

function sentencePool() {
  const ids = new Set(learnedPool().map((word) => word.id));
  return sentenceSeeds.filter((seed) => ids.has(seed.word_id));
}

function renderSentence() {
  const pool = sentencePool();
  if (!pool.length) {
    $("#sentenceProgress").textContent = "暂无句子数据";
    $("#questionSentence").textContent = "当前词组还没有可用句子。";
    $("#passageSentence").textContent = "";
    $("#sentenceOptions").innerHTML = "";
    return;
  }
  const today = todayKey();
  const answered = state.sentenceByDay[today]?.answered || 0;
  const random = seededRandom(hashText(`${today}:sentence:${answered}`));
  const seed = sample(pool, random);
  const distractors = shuffle(pool.filter((item) => item.id !== seed.id), random).slice(0, 3).map((item) => item.answer);
  sentenceItem = { ...seed, options: shuffle([seed.answer, ...distractors], random) };
  $("#sentenceProgress").textContent = `句子识别 · ${answered + 1}`;
  $("#questionSentence").textContent = seed.question_sentence_seed;
  $("#passageSentence").textContent = seed.passage_sentence_seed;
  $("#sentenceFeedback").className = "feedback hidden";
  drawQuestion(sentenceItem, "#sentenceOptions", answerSentence);
}

function answerSentence(chosen) {
  const correct = chosen === sentenceItem.answer;
  const today = todayKey();
  state.sentenceByDay[today] ||= { answered: 0, correct: 0 };
  state.sentenceByDay[today].answered += 1;
  state.sentenceByDay[today].correct += correct ? 1 : 0;
  const word = words.find((item) => item.id === sentenceItem.word_id);
  if (word) {
    recordAnswer(word, correct);
    scheduleWord(word.id, correct ? "good" : "again");
    if (!correct) addMistake("sentence", word, sentenceItem.answer, sentenceItem.answer, `你的答案：${chosen}`);
  }
  saveState();
  markOptions("#sentenceOptions", chosen, sentenceItem.answer);
  $("#sentenceFeedback").className = `feedback ${correct ? "good" : "bad"}`;
  $("#sentenceFeedback").innerHTML = `
    <strong>${correct ? "答对了" : "答错了"}</strong><br>
    正确答案：${escapeHtml(sentenceItem.answer)}<br>
    中文辅助：${escapeHtml(sentenceItem.meaning_cn || "")}<br>
    其他替换：${escapeHtml((sentenceItem.other_replacements || []).join(" / "))}
  `;
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
    category: word.semantic_category,
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
      <button class="ghost-btn" data-remove-mistake="${escapeHtml(itemKey(item))}">已掌握，移出</button>
    </div>
  `).join("") : `<div class="mistake-item"><strong>暂无错题</strong><span>答错后会自动出现在这里。</span></div>`;
  $all("[data-remove-mistake]").forEach((btn) => btn.addEventListener("click", () => {
    delete state.mistakes[btn.dataset.removeMistake];
    saveState();
    renderMistakes();
    renderSummary();
  }));
}

function itemKey(item) {
  return Object.keys(state.mistakes).find((key) => state.mistakes[key] === item) || "";
}

function startMistakeRetest() {
  const items = Object.values(state.mistakes || {});
  if (!items.length) {
    setView("mistakes");
    return;
  }
  const random = seededRandom(hashText(`${todayKey()}:mistake-retest:${items.length}`));
  quizPlan = items.map((item, index) => {
    const word = words.find((entry) => entry.id === item.wordId);
    if (!word) return null;
    return makeQuestion(word, item.prompt || word.word, `mistake_${index}_${item.wordId}`, random, "mistake");
  }).filter(Boolean);
  quizSession = "mistake";
  mistakeQuizState = { answered: 0, correct: 0, answeredIds: {} };
  setView("quiz");
}

function removeMistakesForWord(wordId) {
  Object.entries(state.mistakes || {}).forEach(([key, item]) => {
    if (item.wordId === wordId) delete state.mistakes[key];
  });
}

function recordAnswer(word, correct) {
  state.stats.answered += 1;
  state.stats.correct += correct ? 1 : 0;
  const today = todayKey();
  state.stats.byDay[today] ||= { answered: 0, correct: 0 };
  state.stats.byDay[today].answered += 1;
  state.stats.byDay[today].correct += correct ? 1 : 0;
  const category = word.semantic_category || "unknown";
  state.stats.byCategory[category] ||= { answered: 0, wrong: 0 };
  state.stats.byCategory[category].answered += 1;
  state.stats.byCategory[category].wrong += correct ? 0 : 1;
}

function topMistakes(limit = 5) {
  const byWord = {};
  Object.values(state.mistakes || {}).forEach((item) => {
    byWord[item.word] ||= { word: item.word, primary: item.primary, count: 0 };
    byWord[item.word].count += item.count;
  });
  return Object.values(byWord).sort((a, b) => b.count - a.count).slice(0, limit);
}

function renderStats() {
  const accuracy = state.stats.answered ? Math.round((state.stats.correct / state.stats.answered) * 100) : 0;
  $("#statLearned").textContent = Object.keys(state.learned || {}).length;
  $("#statMastered").textContent = Object.keys(state.mastered || {}).length;
  $("#statAccuracy").textContent = `${accuracy}%`;
  $("#statSevenDays").textContent = sevenDayAnswered();
  $("#topMistakes").innerHTML = topMistakes(8).map((item) => `
    <div class="mistake-item"><strong>${escapeHtml(item.word)} · ${escapeHtml(item.primary)}</strong><span>错 ${item.count} 次</span></div>
  `).join("") || `<div class="mistake-item"><strong>暂无错题</strong></div>`;
  const cats = Object.entries(state.stats.byCategory || {}).sort((a, b) => (b[1].wrong / b[1].answered) - (a[1].wrong / a[1].answered));
  $("#weakCategories").innerHTML = cats.map(([name, value]) => {
    const rate = value.answered ? Math.round((value.wrong / value.answered) * 100) : 0;
    return `<div class="queue-row"><span>${escapeHtml(name)}</span><strong>${value.wrong}/${value.answered} · ${rate}%</strong></div>`;
  }).join("") || `<div class="queue-row"><span>暂无统计</span><strong>0</strong></div>`;
}

function sevenDayAnswered() {
  let total = 0;
  for (let i = 0; i < 7; i += 1) {
    total += state.stats.byDay[addDays(todayKey(), -i)]?.answered || 0;
  }
  return total;
}

function resetToday() {
  const today = todayKey();
  state.seen = Object.fromEntries(Object.entries(state.seen || {}).filter(([key]) => !key.startsWith(`${today}_`)));
  state.quizByDay[today] = { answered: 0, correct: 0, answeredIds: {} };
  state.sentenceByDay[today] = { answered: 0, correct: 0 };
  state.matchedByDay[today] = {};
  learnIndex = 0;
  buildTodayWords();
  buildQuizPlan();
  saveState();
  setView(currentView);
}

function exportProgress() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ielts-538-progress-${todayKey()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function importProgress(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = normalizeState(JSON.parse(reader.result));
      saveState();
      buildTodayWords();
      buildQuizPlan();
      showDataFeedback("导入成功。");
      setView(currentView);
    } catch {
      showDataFeedback("导入失败：文件格式不正确。", true);
    }
  };
  reader.readAsText(file);
}

function showDataFeedback(text, bad = false) {
  $("#dataFeedback").className = `feedback ${bad ? "bad" : "good"}`;
  $("#dataFeedback").textContent = text;
}

function resetAllProgress() {
  if (!confirm("确定要重置全部学习记录吗？这个操作不能撤销。")) return;
  state = defaultState();
  saveState();
  buildTodayWords();
  buildQuizPlan();
  showDataFeedback("全部进度已重置。");
  setView("home");
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
  $("#todayText").textContent = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
  $("#dailyCount").value = String(state.dailyCount || 20);
  $("#dailyCount").addEventListener("change", (event) => {
    state.dailyCount = Number(event.target.value);
    if (state.groups[todayKey()]) state.groups[todayKey()].count = state.dailyCount;
    buildTodayWords();
    buildQuizPlan();
    saveState();
    setView(currentView);
  });
  $("#startNextTaskBtn").addEventListener("click", () => setView(nextTaskView()));
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
  $all("[data-review-grade]").forEach((btn) => btn.addEventListener("click", () => gradeReview(btn.dataset.reviewGrade)));
  $("#nextQuiz").addEventListener("click", renderQuiz);
  $("#newMatch").addEventListener("click", renderMatch);
  $("#nextSentence").addEventListener("click", renderSentence);
  $("#mistakeRetestBtn").addEventListener("click", startMistakeRetest);
  $("#clearMistakesBtn").addEventListener("click", () => {
    state.mistakes = {};
    saveState();
    renderMistakes();
    renderSummary();
  });
  $("#exportBtn").addEventListener("click", exportProgress);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (event) => event.target.files[0] && importProgress(event.target.files[0]));
  $("#resetAllBtn").addEventListener("click", resetAllProgress);
  $("#installBtn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#installBtn").classList.add("hidden");
  });
}

async function init() {
  try {
    registerServiceWorker();
    setupInstallPrompt();
    await loadData();
    bindEvents();
    renderHome();
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

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("#installBtn")?.classList.remove("hidden");
  });
}
