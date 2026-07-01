export function buildDeck() {
  const counts = {
    '-2': 5,
    '-1': 10,
    '0': 15,
  };
  for (let v = 1; v <= 12; v++) counts[String(v)] = 10;

  const deck = [];
  let id = 0;
  for (const [valStr, count] of Object.entries(counts)) {
    const value = parseInt(valStr, 10);
    for (let i = 0; i < count; i++) {
      deck.push({ id: `c${id++}`, value });
    }
  }
  return deck;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
