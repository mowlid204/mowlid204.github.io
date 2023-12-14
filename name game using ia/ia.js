// Pong game logic

const ball = document.getElementById('ball');
const leftPaddle = document.getElementById('leftPaddle');
const rightPaddle = document.getElementById('rightPaddle');

let ballX = 0;
let ballY = 0;
let ballSpeedX = 3;
let ballSpeedY = 3;

function updateBallPosition() {
  ballX += ballSpeedX;
  ballY += ballSpeedY;

  if (ballY <= 0 || ballY >= window.innerHeight - 15) {
    ballSpeedY = -ballSpeedY;
  }

  if (ballX <= 0 || ballX >= window.innerWidth - 15) {
    ballSpeedX = -ballSpeedX;
  }

  ball.style.left = ballX + 'px';
  ball.style.top = ballY + 'px';
}

function updatePaddlePosition(event) {
  const mouseY = event.clientY;

  leftPaddle.style.top = mouseY - 40 + 'px'; // Adjusting paddle position
}

setInterval(updateBallPosition, 16); // Update ball position every 16ms

document.addEventListener('mousemove', updatePaddlePosition);
