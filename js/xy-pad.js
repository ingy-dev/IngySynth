// ----- XY Pad Functionality -----
// Get available control parameters for XY pad dropdowns (exclude step controls and buttons)
function populateXYPadControls() {
    const availableParams = [];
    const excludeControls = ['stepCount'];

    // Find all range inputs that aren't step-related
    document.querySelectorAll('input[type="range"]').forEach(input => {
        const id = input.id;
        if (id && !id.includes('step') && !excludeControls.includes(id)) {
            // Get label text from previous sibling or parent's first child
            let labelText = '';
            if (input.previousElementSibling && input.previousElementSibling.tagName === 'LABEL') {
                labelText = input.previousElementSibling.textContent;
            } else if (input.parentElement && input.parentElement.querySelector('label')) {
                labelText = input.parentElement.querySelector('label').textContent;
            } else {
                labelText = id.charAt(0).toUpperCase() + id.slice(1); // Capitalize first letter
            }

            const fieldset = input.closest('fieldset');
            const group = fieldset?.querySelector('legend')?.textContent.trim() ?? 'Sequencer';

            availableParams.push({
                id: id,
                name: labelText,
                group,
                min: parseFloat(input.min),
                max: parseFloat(input.max),
                value: parseFloat(input.value)
            });
        }
    });

    // Add class-based controls like oscillator volumes and tunes
    ['osc-vol', 'osc-tune'].forEach(className => {
        document.querySelectorAll(`.${className}`).forEach(input => {
            const oscNum = input.dataset.osc;
            const paramType = className === 'osc-vol' ? 'Volume' : 'Tune';

            availableParams.push({
                id: className,
                dataAttribute: 'data-osc',
                dataValue: oscNum,
                name: paramType,
                group: `Oscillator ${parseInt(oscNum, 10) + 1}`,
                min: parseFloat(input.min),
                max: parseFloat(input.max),
                value: parseFloat(input.value)
            });
        });
    });

    return availableParams;
}

function getXYOptionValue(param) {
    return param.dataValue !== undefined ? `${param.id}__${param.dataValue}` : param.id;
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
            if (param.dataAttribute) {
                option.dataset.attribute = param.dataAttribute;
                option.dataset.value = param.dataValue;
            }
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
    return optionValue;
}

function normalizeFromElement(el) {
    if (!el) return null;
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    const value = parseFloat(el.value);
    if (![min, max, value].every(Number.isFinite) || max === min) return null;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
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
        if (!param || param.isNone) return null;
        if (param.isClassBased) {
            const el = param.elements?.[0];
            return normalizeFromElement(el);
        }
        return normalizeFromElement(param.element);
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
        if (paramId === "none") {
            return {
                element: null,
                isClassBased: false,
                isNone: true
            };
        }

        const selectedOption = Array.from(xAxisSelect.options).find(opt => opt.value === paramId) ||
                              Array.from(yAxisSelect.options).find(opt => opt.value === paramId);

        if (selectedOption && selectedOption.dataset.attribute) {
            const className = paramId.split('__')[0];
            return {
                elements: document.querySelectorAll(`.${className}[${selectedOption.dataset.attribute}="${selectedOption.dataset.value}"]`),
                isClassBased: true
            };
        } else {
            // ID-based parameter
            return {
                element: document.getElementById(paramId),
                isClassBased: false
            };
        }
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

    // Map value from XY pad (0-1) to parameter range
    function mapValue(value, paramElement) {
        const min = parseFloat(paramElement.min);
        const max = parseFloat(paramElement.max);
        return value * (max - min) + min;
    }

    // Update parameter values based on XY position
    function updateParameterValues() {
        if (xParam && !xParam.isNone) {
            const xValue = currentX;

            if (xParam.isClassBased) {
                xParam.elements.forEach(element => {
                    const mappedValue = mapValue(xValue, element);
                    element.value = mappedValue;

                    // Trigger input event to update synth
                    const event = new Event('input', { bubbles: true });
                    element.dispatchEvent(event);
                });
            } else if (xParam.element) {
                const mappedValue = mapValue(xValue, xParam.element);
                xParam.element.value = mappedValue;

                // Trigger input event to update synth
                const event = new Event('input', { bubbles: true });
                xParam.element.dispatchEvent(event);
            }
        }

        if (yParam && !yParam.isNone) {
            const yValue = 1 - currentY;

            if (yParam.isClassBased) {
                yParam.elements.forEach(element => {
                    const mappedValue = mapValue(yValue, element);
                    element.value = mappedValue;

                    // Trigger input event to update synth
                    const event = new Event('input', { bubbles: true });
                    element.dispatchEvent(event);
                });
            } else if (yParam.element) {
                const mappedValue = mapValue(yValue, yParam.element);
                yParam.element.value = mappedValue;

                // Trigger input event to update synth
                const event = new Event('input', { bubbles: true });
                yParam.element.dispatchEvent(event);
            }
        }

        // Update visual pointer position
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
