function calculatePaneLayout(termCols, termRows, agentCount) {
  if (agentCount <= 0) {
    return { chatPane: { top: 0, left: 0, width: termCols, height: termRows }, agentPanes: [] };
  }

  const chatWidth = Math.floor(termCols / 3);
  const rightLeft = chatWidth + 1;
  const rightWidth = termCols - chatWidth - 1;

  const chatPane = { top: 0, left: 0, width: chatWidth, height: termRows };

  if (rightWidth < 4 || termRows < 3) {
    return { chatPane: { top: 0, left: 0, width: termCols, height: termRows }, agentPanes: [] };
  }

  const agentPanes = layoutAgentPanes(rightLeft, rightWidth, termRows, agentCount);
  return { chatPane, agentPanes };
}

function layoutAgentPanes(left, width, height, count) {
  if (count === 1) {
    return [{ top: 0, left, width, height }];
  }
  if (count === 2) {
    const h1 = Math.floor(height / 2);
    return [
      { top: 0, left, width, height: h1 },
      { top: h1, left, width, height: height - h1 },
    ];
  }

  // count >= 3: fill rows of 2, first row gets 1 if odd
  const rowCount = Math.ceil(count / 2);
  const rowHeight = Math.floor(height / rowCount);
  const panes = [];
  let placed = 0;

  for (let row = 0; row < rowCount; row++) {
    const rowTop = row * rowHeight;
    const actualHeight = row === rowCount - 1 ? height - rowTop : rowHeight;
    const remaining = count - placed;
    const isOddRow = remaining % 2 === 1 && row === 0 && count % 2 === 1;

    if (isOddRow) {
      panes.push({ top: rowTop, left, width, height: actualHeight });
      placed++;
    } else {
      const halfWidth = Math.floor(width / 2);
      panes.push({ top: rowTop, left, width: halfWidth, height: actualHeight });
      panes.push({ top: rowTop, left: left + halfWidth + 1, width: width - halfWidth - 1, height: actualHeight });
      placed += 2;
    }
  }

  return panes;
}

module.exports = { calculatePaneLayout };
