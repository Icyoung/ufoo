"use strict";

/**
 * Tool description for read_image (workspace vision).
 */

const READ_IMAGE_TOOL_NAME = "read_image";

function getReadImageToolDescription() {
  return `Read an image file from the workspace so the model can see it.

Usage notes:
- The path parameter is relative to the workspace root.
- Supports png, jpeg, gif, and webp. Max size ~5MB.
- Use this instead of read for screenshots, UI mocks, diagrams, and other binary images.
- Text files still use read. Do not call read_image on non-image files.
- Vision is attached for the current model call only; call read_image again if you need the image later.`;
}

module.exports = {
  READ_IMAGE_TOOL_NAME,
  getReadImageToolDescription,
};
