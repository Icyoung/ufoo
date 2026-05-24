function calculatePaneLayout(termCols, termRows, agentCount) {
  const bottomRows = 5;
  const safeRows = termRows - 1;
  const contentHeight = Math.max(1, safeRows - bottomRows);
  const bottomTop = contentHeight;

  const statusPane = { top: bottomTop, left: 0, width: termCols };
  const separatorPane = { top: bottomTop + 1, left: 0, width: termCols };
  const inputPane = { top: bottomTop + 2, left: 0, width: termCols };
  const inputSepPane = { top: bottomTop + 3, left: 0, width: termCols };
  const dashboardPane = { top: bottomTop + 4, left: 0, width: termCols };

  if (agentCount <= 0) {
    return {
      separatorPane,
      statusPane,
      inputPane,
      inputSepPane,
      dashboardPane,
      chatPane: { top: 0, left: 0, width: termCols, height: contentHeight },
      agentPanes: [],
    };
  }

  const chatWidth = Math.floor(termCols / 3);
  const rightLeft = chatWidth + 1;
  const rightWidth = termCols - chatWidth - 1;

  const chatPane = { top: 0, left: 0, width: chatWidth, height: contentHeight };

  if (rightWidth < 4 || contentHeight < 3) {
    return {
      separatorPane,
      statusPane,
      inputPane,
      inputSepPane,
      dashboardPane,
      chatPane: { top: 0, left: 0, width: termCols, height: contentHeight },
      agentPanes: [],
    };
  }

  const agentPanes = layoutAgentPanes(rightLeft, rightWidth, contentHeight, agentCount, 0);
  return { separatorPane, statusPane, inputPane, inputSepPane, dashboardPane, chatPane, agentPanes };
}

function layoutAgentPanes(left, width, height, count, topOffset = 0) {
  if (count === 1) {
    return [{ top: topOffset, left, width, height }];
  }
  if (count === 2) {
    const h1 = Math.floor(height / 2);
    return [
      { top: topOffset, left, width, height: h1 },
      { top: topOffset + h1, left, width, height: height - h1 },
    ];
  }

  const rowCount = Math.ceil(count / 2);
  const rowHeight = Math.floor(height / rowCount);
  const panes = [];
  let placed = 0;

  for (let row = 0; row < rowCount; row++) {
    const rowTop = topOffset + row * rowHeight;
    const actualHeight = row === rowCount - 1 ? height - row * rowHeight : rowHeight;
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
