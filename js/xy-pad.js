// ----- XY Pad Functionality -----
import { getNumber, set } from './params.js?v=44';
import { getParam, xyPadEntries } from './param-catalog.js?v=10';

function populateXYPadControls() {
    return xyPadEntries();
}

function getXYOptionValue(param) {
    return param.id;
}

function populateXYSelect(select, params) {
    select.innerHTML = '';

    const noneOption = document.createElement('option');
    noneOption.value = 'none';
    noneOption.textContent = 'None';
    select.appendChild(noneOption);

    const groupOrder = [];
    const grouped = new Map();
    params.forEach(param => {
        if (!grouped.has(param.group)) {
            grouped.set(param.group, []);
            groupOrder.push(param.group);
        }
        grouped.get(param.group).push(param);
    });

    groupOrder.forEach(groupName => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = groupName;
        grouped.get(groupName).forEach(param => {
            const option = document.createElement('option');
            option.value = getXYOptionValue(param);
            option.textContent = param.name;
            optgroup.appendChild(option);
        });
        select.appendChild(optgroup);
    });
}

function getXYAxisLabel(select) {
    const opt = select.options[select.selectedIndex];
    return opt?.textContent ?? '';
}

let drawXYPadFn = null;
/** @type {null | (() => { x: string|null, y: string|null })} */
let getAxisKeysFn = null;
/** @type {null | ((axes: { x?: boolean, y?: boolean }) => void)} */
let followAutomationFn = null;

/** Redraw the pad after the collapsible panel opens or layout changes. */
export function refreshXYPad() {
    if (typeof drawXYPadFn === 'function') drawXYPadFn();
}

/** Automation keys for the current X/Y assignments (`null` if None / unbound). */
export function getXYPadAutomationKeys() {
    return getAxisKeysFn ? getAxisKeysFn() : { x: null, y: null };
}

/**
 * Move the pointer to match mapped param values for axes that already have
 * automation. Skipped while the user is dragging the pad.
 * @param {{ x?: boolean, y?: boolean }} axes
 */
export function followXYPadAutomation(axes) {
    if (typeof followAutomationFn === 'function') followAutomationFn(axes || {});
}

function optionValueToAutomationKey(optionValue) {
    if (!optionValue || optionValue === 'none') return null;
    if (optionValue.includes('__')) {
        const [cls, osc] = optionValue.split('__');
        if (cls === 'osc-vol' || cls === 'osc-tune') return `${cls}-${osc}`;
        return null;
    }
    return getParam(optionValue) ? optionValue : null;
}

function normalizeFromKey(key) {
    const spec = getParam(key);
    if (!spec || spec.type !== 'range') return null;
    const min = spec.min;
    const max = spec.max;
    const value = getNumber(key, spec.default);
    if (![min, max, value].every(Number.isFinite) || max === min) return null;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function mapNormToKey(norm, key) {
    const spec = getParam(key);
    if (!spec || spec.type !== 'range') return null;
    return spec.min + norm * (spec.max - spec.min);
}

// Initialize XY pad and dropdowns
function initXYPad() {
    const xyPad = document.getElementById('xyPad');
    const xyPointer = document.getElementById('xyPointer');
    const xAxisSelect = document.getElementById('xAxisParam');
    const yAxisSelect = document.getElementById('yAxisParam');

    if (!xyPad || !xyPointer || !xAxisSelect || !yAxisSelect) return;

    const ctx = xyPad.getContext('2d');
    let isActive = false;
    let xParam, yParam;
    let currentX = 0.5;
    let currentY = 0.5;

    // Trail effect variables
    const trailPoints = [];
    const maxTrailLength = 15; // Maximum number of points in the trail

    // Get available parameters
    const availableParams = populateXYPadControls();

    populateXYSelect(xAxisSelect, availableParams);
    populateXYSelect(yAxisSelect, availableParams);

    // Set default values
    if (availableParams.length >= 2) {
        xAxisSelect.value = 'cutoff';
        yAxisSelect.value = 'resonance';
        updateXYParameters();
    }

    // Draw the XY pad
    function drawXYPad() {
        const width = xyPad.width;
        const height = xyPad.height;

        // Clear canvas with black background
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);

        // Draw grid lines
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.2)';
        ctx.lineWidth = 1;

        // Vertical grid lines
        for (let i = 1; i < 5; i++) {
            const x = (width * i) / 5;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }

        // Horizontal grid lines
        for (let i = 1; i < 5; i++) {
            const y = (height * i) / 5;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        // Draw trail effect
        if (trailPoints.length > 0) {
            // Draw glow trails
            for (let i = 0; i < trailPoints.length; i++) {
                const point = trailPoints[i];
                const alpha = 0.7 * (i / trailPoints.length); // Fade out older points
                const size = 10 * (i / trailPoints.length); // Smaller for older points

                ctx.beginPath();
                ctx.arc(point.x * width, point.y * height, size, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(0, 255, 0, ${alpha})`;
                ctx.fill();
            }
        }

        // Draw parameter labels
        ctx.fillStyle = '#00ff00';
        ctx.font = '12px Michroma, sans-serif';
        ctx.textAlign = 'center';

        // X axis labels (bottom)
        ctx.fillText(getXYAxisLabel(xAxisSelect), width / 2, height - 15);

        // Y axis labels (rotated on left)
        ctx.save();
        ctx.translate(15, height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(getXYAxisLabel(yAxisSelect), 0, 0);
        ctx.restore();

        // Update pointer position
        updatePointerPosition();
    }

    drawXYPadFn = drawXYPad;

    getAxisKeysFn = () => ({
        x: optionValueToAutomationKey(xAxisSelect.value),
        y: optionValueToAutomationKey(yAxisSelect.value),
    });

    function readParamNormalized(param) {
        if (!param || param.isNone || !param.key) return null;
        return normalizeFromKey(param.key);
    }

    followAutomationFn = (axes) => {
        if (isActive) return;
        let moved = false;
        if (axes.x) {
            const n = readParamNormalized(xParam);
            if (n != null) {
                currentX = n;
                moved = true;
            }
        }
        if (axes.y) {
            const n = readParamNormalized(yParam);
            if (n != null) {
                currentY = 1 - n;
                moved = true;
            }
        }
        if (moved) updatePointerPosition();
    };

    // Update the visual position of the pointer
    function updatePointerPosition() {
        xyPointer.style.left = `${currentX * 100}%`;
        xyPointer.style.top = `${currentY * 100}%`;
    }

    // Get parameter by id or class and data attributes
    function getParameter(paramId) {
        if (paramId === 'none') {
            return { key: null, isNone: true };
        }
        const key = optionValueToAutomationKey(paramId);
        if (!key) return { key: null, isNone: true };
        return { key, isNone: false };
    }

    // Update parameters based on dropdown selections
    function updateXYParameters() {
        const xParamId = xAxisSelect.value;
        const yParamId = yAxisSelect.value;

        xParam = getParameter(xParamId);
        yParam = getParameter(yParamId);

        // Update visuals
        drawXYPad();
    }

    function updateParameterValues() {
        if (xParam && !xParam.isNone && xParam.key) {
            const mapped = mapNormToKey(currentX, xParam.key);
            if (mapped != null) set(xParam.key, mapped);
        }

        if (yParam && !yParam.isNone && yParam.key) {
            const mapped = mapNormToKey(1 - currentY, yParam.key);
            if (mapped != null) set(yParam.key, mapped);
        }

        updatePointerPosition();
    }

    // Handle touch/mouse events
    function handleStart(e) {
        isActive = true;
        xyPointer.style.boxShadow = '0 0 15px rgba(0, 255, 0, 0.9)';

        // Clear trail points when starting a new interaction
        trailPoints.length = 0;

        handleMove(e);
    }

    function handleMove(e) {
        if (!isActive) return;

        e.preventDefault();

        const rect = xyPad.getBoundingClientRect();
        let clientX, clientY;

        if (e.type.includes('touch')) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        // Calculate position relative to pad (0-1)
        currentX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        currentY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

        // Add point to trail
        trailPoints.push({x: currentX, y: currentY});

        // Limit trail length
        if (trailPoints.length > maxTrailLength) {
            trailPoints.shift(); // Remove oldest point
        }

        // Update parameter values
        updateParameterValues();

        // Redraw with updated trail
        drawXYPad();
    }

    function handleEnd() {
        isActive = false;
        xyPointer.style.boxShadow = '0 0 6px rgba(0, 255, 0, 0.55)';

        // Clear trail after a short delay
        setTimeout(() => {
            trailPoints.length = 0;
            drawXYPad();
        }, 300);
    }

    // Add event listeners
    xyPad.addEventListener('mousedown', handleStart);
    xyPad.addEventListener('touchstart', handleStart);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('touchmove', handleMove, { passive: false });

    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchend', handleEnd);

    // Update when parameters change
    xAxisSelect.addEventListener('change', updateXYParameters);
    yAxisSelect.addEventListener('change', updateXYParameters);

    // Initial draw
    drawXYPad();
}

// Initialize XY pad when DOM is loaded
window.addEventListener('load', initXYPad);
