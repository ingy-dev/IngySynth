function setupMobileSwipe() {
    const container = document.getElementById('synthContainer');
    const navBars = Array.from(document.querySelectorAll('.swipe-dots'));
    const allDots = document.querySelectorAll('.swipe-dot');
    const leftArrows = document.querySelectorAll('.swipe-arrow-left, [data-swipe-dir="left"]');
    const rightArrows = document.querySelectorAll('.swipe-arrow-right, [data-swipe-dir="right"]');
    let touchStartX = 0;
    let touchEndX = 0;
    let touchStartTime = 0;
    let currentIndex = 0;

    if (!container || navBars.length === 0) return;

    // Only initialize mobile swipe for smaller screens
    function checkMobile() {
        if (window.innerWidth <= 768) {
            navBars.forEach(bar => {
                bar.style.display = 'flex';
            });

            // Set initial section widths correctly
            const sections = container.querySelectorAll('.section');
            sections.forEach(section => {
                section.style.minWidth = '100%';
                section.style.maxWidth = '100%';
            });

            // Ensure container has proper width
            container.style.width = '100%';
            container.style.maxWidth = '100%';
            container.style.boxSizing = 'border-box';
            container.style.left = '0';
            container.style.overflowX = 'hidden';

            // Set initial scroll position to first section
            if (container.scrollLeft === 0) {
                updateActiveDot(0);
            }
        } else {
            navBars.forEach(bar => {
                bar.style.display = 'none';
            });

            // Reset styles when not in mobile mode
            const sections = container.querySelectorAll('.section');
            sections.forEach(section => {
                section.style.minWidth = '';
                section.style.maxWidth = '';
            });

            container.style.width = '';
            container.style.maxWidth = '';
        }
    }

    // Handle scroll event to update active dot
    function handleScroll() {
        if (window.innerWidth <= 768) {
            const scrollPosition = container.scrollLeft;
            const sectionWidth = container.offsetWidth;
            const index = Math.round(scrollPosition / sectionWidth);

            if (index !== currentIndex) {
                currentIndex = index;
                updateActiveDot(index);
            }
        }
    }

    // Update active dots on every page selector
    function updateActiveDot(index) {
        allDots.forEach(dot => {
            const i = parseInt(dot.dataset.index, 10);
            if (i === index) {
                dot.classList.add('active');
            } else {
                dot.classList.remove('active');
            }
        });
    }

    // Set up event listeners for dots and arrows
    function setupNavigationControls() {
        allDots.forEach(dot => {
            dot.addEventListener('click', () => {
                const index = parseInt(dot.dataset.index, 10);
                if (Number.isFinite(index)) scrollToSection(index);
            });
        });

        leftArrows.forEach(arrow => {
            arrow.addEventListener('click', () => handleArrowClick('left'));
        });

        rightArrows.forEach(arrow => {
            arrow.addEventListener('click', () => handleArrowClick('right'));
        });
    }

    // Scroll to section
    function scrollToSection(index) {
        const sectionWidth = container.offsetWidth;
        container.scrollTo({
            left: index * sectionWidth,
            behavior: 'smooth'
        });
        updateActiveDot(index);
        currentIndex = index;
    }

    // Handle navigation arrow clicks
    function handleArrowClick(direction) {
        if (direction === 'left' && currentIndex > 0) {
            scrollToSection(currentIndex - 1);
        } else if (direction === 'right' && currentIndex < 3) {
            scrollToSection(currentIndex + 1);
        }
    }

    // Add touch event listeners
    container.addEventListener('touchstart', (e) => {
        // Only track single-finger touches for swipes
        if (e.touches.length === 1) {
            touchStartX = e.changedTouches[0].screenX;
            touchStartTime = Date.now();
        }
    });

    container.addEventListener('touchend', (e) => {
        // Only process single-finger touches, ignore multi-finger gestures (likely zoom)
        if (e.touches.length === 0 && e.changedTouches.length === 1) {
            touchEndX = e.changedTouches[0].screenX;
            const touchEndTime = Date.now();
            handleSwipe(touchEndTime - touchStartTime);
        }
    });

    // Handle swipe direction
    function handleSwipe(swipeDuration) {
        if (window.innerWidth > 768) return;

        const swipeThreshold = 75; // Increase threshold to require more intentional swipes
        const maxSwipeTime = 500; // Maximum time for a swipe in milliseconds
        const diff = touchStartX - touchEndX;

        // Only register as a swipe if it's quick enough and exceeds threshold
        if (Math.abs(diff) < swipeThreshold || swipeDuration > maxSwipeTime) return;

        if (diff > 0) {
            // Swiped left, go to next section
            if (currentIndex < 3) {
                scrollToSection(currentIndex + 1);
            }
        } else {
            // Swiped right, go to previous section
            if (currentIndex > 0) {
                scrollToSection(currentIndex - 1);
            }
        }
    }

    // Add keyboard arrow navigation for mobile view on desktop
    document.addEventListener('keydown', (e) => {
        // Only handle arrow keys if in mobile width
        if (window.innerWidth > 768) return;

        // Prevent arrow key scrolling of the page
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
        }

        // Navigate based on arrow key direction
        if (e.key === 'ArrowLeft' && currentIndex > 0) {
            scrollToSection(currentIndex - 1);
        } else if (e.key === 'ArrowRight' && currentIndex < 3) {
            scrollToSection(currentIndex + 1);
        }
    });

    // Add scroll event listener
    container.addEventListener('scroll', handleScroll);

    // Add resize listener to check mobile size and adjust layout accordingly
    window.addEventListener('resize', () => {
        checkMobile();
        // Re-adjust scroll position after resize to keep current section visible
        if (window.innerWidth <= 768) {
            setTimeout(() => scrollToSection(currentIndex), 100);
        }
    });

    // Initial check
    checkMobile();

    // Set up navigation controls
    setupNavigationControls();
}

// Call setup after audio is initialized
document.addEventListener('DOMContentLoaded', function() {
    if (document.readyState === 'complete') {
        setupMobileSwipe();
    } else {
        window.addEventListener('load', function() {
            setupMobileSwipe();
        });
    }
});
