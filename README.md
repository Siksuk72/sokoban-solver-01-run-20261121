# Sokoban solver — make.fun bounty entry

A push-optimal Sokoban solver for
[make.fun's "Build the best Sokoban solver, 21 November 2026" bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121)
(`sokoban-solver-01-run-20261121`). One program answers all 5 instances of
a set in a single run, in as few pushes as possible.

## How it works

The levels this competition draws are a one-square-wide hallway with
independent rooms off it — one door per room, and a box pushed out of a door
can never come back, so every box stays in its room and a level's push
optimum is the sum of its rooms' optima. The solver exploits that:

1. **Split** — cut the hallway out of the floor (the player's row, minus the
   squares a box could ever reach a goal from) and take each connected part
   holding boxes as one room.
2. **Solve each room push-optimally** with an A* search over pushes (not
   moves). A state is the boxes plus the player's reachable region, named by
   its lowest square. The estimate is the cheapest assignment of boxes to
   goals by walking distance, and dead positions are pruned with a
   reverse-pull liveness table (a box on a square no pull can bring to a
   goal) plus a frozen 2x2 test. Rooms are solved in turn with the other
   rooms' boxes standing as walls, and the moves are stitched together with
   shortest walks along the hallway.
3. **Verify** — every instance's moves are replayed on its level before
   writing; a replay that does not solve the level is replaced by an empty
   (valid, unanswered) solution rather than an illegal one.

Everything is budgeted by work (a fixed number of expanded states per room),
never by the clock, so two runs write the same bytes. No network, no
dependencies, only Node built-ins.

## Results

| set | score | time |
| --- | --- | --- |
| Practice set (kit) | **1,000,000** — all 5 instances in exactly P\* pushes (13, 16, 29, 47, 60) | ~0.4 s |
| House baseline plain-astar 1.0.0 on the same set | 200,000 (solves only i001) | ~6.3 s |
| 5 freshly drawn sets (kit generator, random seeds) | **1,000,000** on each | ~0.3–0.5 s each |

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt` (or `MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `MAKEFUN_OUTPUT_DIR`) for every instance.

## License

MIT — see `LICENSE`.
