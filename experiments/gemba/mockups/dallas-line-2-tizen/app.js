/* Conservative ES5-style demo logic for the 2019 Tizen web runtime. */
(function () {
  "use strict";

  var started = Date.now();
  var caseCount = 6842;
  var rejects = 38;
  var jammed = false;
  var history = [];
  var board = document.getElementById("board");
  var button = document.getElementById("scenario-button");
  var palletCases = 91;

  function text(id, value) {
    document.getElementById(id).textContent = value;
  }

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function clockText(date) {
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  function numberWithCommas(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function buildPallet() {
    var grid = document.getElementById("pallet-grid");
    var i;
    for (i = 0; i < 24; i += 1) {
      var cell = document.createElement("span");
      cell.textContent = pad(i + 1);
      if (i < 22) cell.className = "is-loaded";
      else if (i === 22) cell.className = "is-next";
      grid.appendChild(cell);
    }
  }

  function updatePallet() {
    var loaded = ((palletCases - 1) % 24) + 1;
    var cells = document.getElementById("pallet-grid").getElementsByTagName("span");
    var i;
    for (i = 0; i < cells.length; i += 1) {
      cells[i].className = i < loaded ? "is-loaded" : (i === loaded ? "is-next" : "");
    }
    var percent = Math.min(100, Math.round((palletCases / 120) * 100));
    text("pallet-cases", palletCases + " / 120");
    text("pallet-percent", percent + "%");
    document.getElementById("pallet-progress-bar").style.width = percent + "%";
  }

  function drawCurrent(values) {
    var width = 600;
    var height = 128;
    var low = 3.5;
    var high = 10.5;
    var path = "";
    var i;
    for (i = 0; i < values.length; i += 1) {
      var x = values.length === 1 ? 0 : (i / (values.length - 1)) * width;
      var y = height - ((values[i] - low) / (high - low)) * height;
      path += (i === 0 ? "M" : " L") + x.toFixed(1) + " " + y.toFixed(1);
    }
    document.getElementById("current-line").setAttribute("d", path);
    document.getElementById("current-area").setAttribute("d", path + " L" + width + " " + height + " L0 " + height + " Z");
  }

  function tick() {
    var elapsed = (Date.now() - started) / 1000;
    var rate = jammed ? Math.max(0, 4 - elapsed % 4) : 27.6 + Math.sin(elapsed / 5) * 0.55;
    var current = jammed ? 9.6 + Math.sin(elapsed * 1.9) * 0.55 : 6.2 + Math.sin(elapsed / 2.3) * 0.42 + Math.sin(elapsed * 1.4) * 0.18;
    var glue = 176 + Math.sin(elapsed / 18) * 1.1;
    var weight = 12.18 + Math.sin(elapsed / 4.7) * 0.025;
    var magazine = Math.max(8, 62 - (elapsed / 15) % 54);

    caseCount += rate / 120;
    if (!jammed && Math.floor(elapsed) > 0 && Math.floor(elapsed) % 22 === 0 && elapsed % 1 < 0.55) {
      palletCases += 1;
      if (palletCases > 120) palletCases = 1;
    }
    if (jammed && Math.floor(elapsed) % 13 === 0 && elapsed % 1 < 0.55) rejects += 1;

    history.push(current);
    if (history.length > 54) history.shift();

    text("clock", clockText(new Date()));
    text("case-rate", rate.toFixed(1));
    text("rate-delta", (rate - 28 >= 0 ? "+" : "") + (rate - 28).toFixed(1));
    text("case-count", numberWithCommas(Math.floor(caseCount)));
    text("reject-count", numberWithCommas(rejects));
    text("motor-current", current.toFixed(1));
    text("glue-temp", Math.round(glue));
    text("case-weight", weight.toFixed(2));
    text("vision-pass", (jammed ? 98.7 : 99.4) + "%");
    text("magazine-level", Math.round(magazine) + "% remaining");
    text("pallet-eta", jammed ? "PAUSED" : "03:" + pad(Math.round(18 + (elapsed % 10))));
    updatePallet();
    drawCurrent(history);
  }

  function toggleJam() {
    jammed = !jammed;
    board.className = jammed ? "board is-jammed" : "board";
    button.setAttribute("aria-pressed", String(jammed));
    document.getElementById("packer-machine").className = jammed ? "machine machine--alert" : "machine machine--good";
    text("status-text", jammed ? "BLOCKED · PACKER JAM" : "RUNNING CLEAN");
    text("status-detail", jammed ? "Robot cell discharge photoeye held" : "Case packer synchronized with palletizer");
    text("packer-state", jammed ? "Jammed" : "Running");
    text("packer-detail", jammed ? "9.8 A · stopped" : "6.2 A load");
    text("risk-chip", jammed ? "ACTION NOW" : "LOW RISK");
    text("jam-status", jammed ? "BLOCKED" : "CLEAR");
    text("attention-text", jammed ? "Clear case at packer discharge and inspect guide rail" : "Carton magazine refill in approximately 11 minutes");
  }

  button.addEventListener("click", toggleJam);
  document.addEventListener("keydown", function (event) {
    if (event.key === "j" || event.key === "J") toggleJam();
  });
  buildPallet();
  tick();
  window.setInterval(tick, 500);
}());
