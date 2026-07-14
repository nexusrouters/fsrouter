# Contributing to AMRouter

First off, thank you for considering contributing to AMRouter! It's people like you that make AMRouter such a great tool.

## Where do I go from here?

If you've noticed a bug or have a feature request, make sure to check our [Issues](https://github.com/nexusrouters/fsrouter/issues) to see if someone else has already created a ticket. If not, go ahead and make one!

## Fork & create a branch

If this is something you think you can fix, then fork AMRouter and create a branch with a descriptive name.

A good branch name would be (where issue #325 is the ticket you're working on):

```sh
git checkout -b 325-add-new-provider
```

## Get the test suite running

Make sure you're using the right versions of Node.js. We recommend using `nvm` or `fnm` to manage your Node versions. 

1. Install dependencies:
   ```sh
   npm install
   ```
2. Start the development server (frontend & backend):
   ```sh
   npm run dev
   ```

## Implement your fix or feature

At this point, you're ready to make your changes! Feel free to ask for help; everyone is a beginner at first. 

* Make sure your code is clean, readable, and well-commented where necessary.
* For UI changes, try to follow the existing design aesthetics.
* If you added a new feature or fixed a bug, make sure to update `frontend/public/CHANGELOG.md`.

## Make a Pull Request

At this point, you should switch back to your master branch and make sure it's up to date with AMRouter's master branch:

```sh
git remote add upstream git@github.com:ahwanulm/amrouter.git
git checkout master
git pull upstream master
```

Then update your feature branch from your local copy of master, and push it!

```sh
git checkout 325-add-new-provider
git rebase master
git push --set-upstream origin 325-add-new-provider
```

Finally, go to GitHub and make a Pull Request! We'll review your changes and merge them as soon as possible.

## Keeping your Pull Request updated

If a maintainer asks you to "rebase" your PR, they're saying that a lot of code has changed, and that you need to update your branch so it's easier to merge.

## Need help?

If you need any help, feel free to start a discussion in our [GitHub Discussions](https://github.com/nexusrouters/fsrouter/discussions) tab. We're happy to help!
