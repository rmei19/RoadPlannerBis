#!/bin/bash

set -e

if [ -t 1 ]; then clear; fi

echo "=================================================="
echo "        🚀 Publication GitHub Pages"
echo "=================================================="
echo ""

# Vérification que l'on est bien dans un dépôt Git
if [ ! -d ".git" ]; then
    echo "❌ Ce dossier n'est pas un dépôt Git."
    exit 1
fi

# Vérification des marqueurs de conflit Git
echo "🔎 Vérification des conflits Git..."

if grep -R -n -E '^(<<<<<<<|=======|>>>>>>>)' . \
    --exclude-dir=.git \
    --exclude=push.sh
then
    echo ""
    echo "❌ Des conflits Git non résolus ont été trouvés."
    echo "Corrige-les avant de continuer."
    exit 1
fi

echo "✅ Aucun conflit détecté."
echo ""

# Ajout des fichiers
git add .

# Ne crée un commit que si des fichiers ont changé. Le push doit aussi
# envoyer les commits déjà créés, même si le dossier de travail est propre.
if git diff --cached --quiet; then
    echo "ℹ️  Aucun nouveau fichier à committer. Vérification des commits à envoyer..."
else
    echo "=================================================="
    echo "📝 Modifications qui seront envoyées"
    echo "=================================================="
    git status --short
    echo ""
    echo "Résumé :"
    git diff --cached --stat
    echo ""
    DEFAULT="Mise à jour du $(date '+%d/%m/%Y à %H:%M')"
    read -r -p "Message du commit [$DEFAULT] : " MESSAGE
    MESSAGE=${MESSAGE:-$DEFAULT}
    echo ""
    echo "💾 Création du commit..."
    git commit -m "$MESSAGE"
fi

echo ""
echo "☁️  Envoi sur GitHub..."
git push

echo ""
echo "=================================================="
echo "✅ Publication terminée"
echo "=================================================="

echo ""
echo "Dernier commit :"
git log -1 --oneline

REMOTE=$(git remote get-url origin)

if [[ "$REMOTE" =~ github.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
    USER="${BASH_REMATCH[1]}"
    REPO="${BASH_REMATCH[2]}"

    echo ""
    echo "📦 Dépôt GitHub"
    echo "https://github.com/${USER}/${REPO}"

    echo ""
    echo "🌍 GitHub Pages"
    echo "https://${USER}.github.io/${REPO}/"

    echo ""
    echo "⏳ Le déploiement peut prendre 30 à 60 secondes."
fi

echo ""
echo "🎉 Terminé."
