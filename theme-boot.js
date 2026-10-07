(function () {
  var theme = "light";
  try {
    if (localStorage.getItem("recap_theme") === "dark") {
      theme = "dark";
    }
  } catch (error) {}
  document.documentElement.setAttribute("data-theme", theme);
})();
